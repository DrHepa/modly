import asyncio
import json
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from starlette.requests import Request

import routers.model as model_router


SOURCES = [
    {
        "id": "primary",
        "provider": "huggingface",
        "repo_id": "org/main",
        "destination": ".",
        "checks": ["main.bin"],
    },
    {
        "id": "encoder",
        "provider": "huggingface",
        "repo_id": "org/encoder",
        "destination": "auxiliary/encoder",
        "checks": ["encoder.bin"],
    },
]


def request_for(sources: list[dict] | None = None) -> Request:
    body = (b"{}" if sources is None else json.dumps({"sources": sources}).encode())
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http",
        "method": "POST",
        "path": "/model/hf-download-sources",
        "headers": [(b"authorization", b"Bearer test-token")],
        "query_string": b"",
        "server": ("test", 80),
        "client": ("test", 1),
        "scheme": "http",
    }, receive)


async def collect_events(response) -> list[dict]:
    payload = ""
    async for chunk in response.body_iterator:
        payload += chunk.decode() if isinstance(chunk, bytes) else chunk
    return [
        json.loads(block[6:])
        for block in payload.strip().split("\n\n")
        if block.startswith("data: ")
    ]


class MultiSourceRouterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="modly-model-router-")
        self.models_dir = Path(self.tempdir.name) / "models"
        self.models_dir.mkdir()
        self.old_models_dir = model_router.registry_module.MODELS_DIR
        self.old_registry = model_router.generator_registry
        model_router.registry_module.MODELS_DIR = self.models_dir
        self.registry_sources = SOURCES

        class RegistryStub:
            def __init__(stub_self, outer):
                stub_self.outer = outer

            def get_model_sources_plan(stub_self, model_id):
                if model_id != "pixal3d/generate":
                    raise KeyError(model_id)
                return stub_self.outer.registry_sources

            def canonical_model_dir(stub_self, model_id):
                if model_id != "pixal3d/generate":
                    raise KeyError(model_id)
                from services.model_sources import resolve_model_root
                return resolve_model_root(model_router.registry_module.MODELS_DIR, model_id)

            def get_weight_group_sources_plan(stub_self, model_id, target_owner_id):
                if target_owner_id != "pixal3d/_shared/base" or model_id not in ("pixal3d/generate", target_owner_id):
                    raise ValueError(target_owner_id)
                from services.model_sources import resolve_weight_storage_root
                return resolve_weight_storage_root(model_router.registry_module.MODELS_DIR, target_owner_id), [SOURCES[0]]

            def __getattr__(stub_self, name):
                return getattr(stub_self.outer.old_registry, name)

        model_router.generator_registry = RegistryStub(self)
        self.old_hf_module = sys.modules.get("huggingface_hub")

    def tearDown(self) -> None:
        model_router.registry_module.MODELS_DIR = self.old_models_dir
        model_router.generator_registry = self.old_registry
        model_router._download_controls.clear()
        if self.old_hf_module is None:
            sys.modules.pop("huggingface_hub", None)
        else:
            sys.modules["huggingface_hub"] = self.old_hf_module
        self.tempdir.cleanup()

    def install_hf_stub(self, files: dict[str, list[str]], calls: list[str]) -> None:
        module = types.ModuleType("huggingface_hub")

        def list_repo_files(repo_id, revision=None, token=None):
            calls.append(f"list:{repo_id}:{revision}:{token}")
            return files[repo_id]

        def hf_hub_url(repo_id, filename, revision=None):
            return f"https://example.invalid/{repo_id}/{revision or 'main'}/{filename}"

        module.list_repo_files = list_repo_files
        module.hf_hub_url = hf_hub_url
        sys.modules["huggingface_hub"] = module

    def test_lists_every_source_before_sequential_download_with_monotonic_progress(self) -> None:
        calls: list[str] = []
        controls: list[int] = []
        self.install_hf_stub({"org/main": ["main.bin"], "org/encoder": ["encoder.bin"]}, calls)

        def fake_download(**kwargs):
            calls.append(f"download:{kwargs['dest_dir']}:{kwargs['filename']}")
            controls.append(id(kwargs["control"]))
            target = Path(kwargs["dest_dir"]) / kwargs["filename"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"data")
            kwargs["progress_cb"]({
                "percent": kwargs["base_percent"],
                "file": kwargs["filename"],
                "fileIndex": kwargs["file_index"],
                "totalFiles": kwargs["total_files"],
                "status": "Downloading...",
                "bytesDownloaded": 4,
                "stalledSeconds": 0,
            })
            return 4

        async def run():
            with patch.object(model_router, "_download_file_streamed", fake_download):
                response = await model_router.hf_download_sources(
                    request_for(SOURCES), "pixal3d/generate"
                )
                return await collect_events(response)

        events = asyncio.run(run())
        first_download = next(index for index, value in enumerate(calls) if value.startswith("download:"))
        self.assertTrue(all(value.startswith("list:") for value in calls[:first_download]))
        self.assertEqual(len(set(controls)), 1)
        self.assertEqual([event["percent"] for event in events if "percent" in event], sorted(
            event["percent"] for event in events if "percent" in event
        ))
        self.assertEqual(events[-1], {"percent": 100, "status": "done"})
        self.assertTrue((self.models_dir / "pixal3d/generate/main.bin").is_file())
        self.assertTrue((self.models_dir / "pixal3d/generate/auxiliary/encoder/encoder.bin").is_file())

    def test_pause_cancel_and_resume_reuse_one_model_control(self) -> None:
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["main.bin"]}, calls)
        source = [SOURCES[0]]
        self.registry_sources = source
        mode = "pause"

        def controlled_download(**kwargs):
            target = Path(kwargs["dest_dir"]) / kwargs["filename"]
            target.parent.mkdir(parents=True, exist_ok=True)
            part = Path(f"{target}.part")
            part.write_bytes(b"partial")
            if mode == "pause":
                kwargs["control"]["pause"].set()
                model_router._check_download_control(kwargs["control"])
            if mode == "cancel":
                kwargs["control"]["cancel"].set()
                model_router._check_download_control(kwargs["control"])
            part.replace(target)
            return target.stat().st_size

        async def one_run():
            with patch.object(model_router, "_download_file_streamed", controlled_download):
                response = await model_router.hf_download_sources(
                    request_for(source), "pixal3d/generate"
                )
                return await collect_events(response)

        paused = asyncio.run(one_run())
        self.assertTrue(paused[-1]["paused"])
        self.assertTrue((self.models_dir / "pixal3d/generate/main.bin.part").is_file())

        mode = "cancel"
        cancelled = asyncio.run(one_run())
        self.assertTrue(cancelled[-1]["cancelled"])
        self.assertFalse((self.models_dir / "pixal3d/generate/main.bin.part").exists())

        mode = "resume"
        resumed = asyncio.run(one_run())
        self.assertEqual(resumed[-1], {"percent": 100, "status": "done"})
        self.assertTrue((self.models_dir / "pixal3d/generate/main.bin").is_file())

    def test_shared_target_downloads_under_extension_reserved_root(self) -> None:
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["main.bin"]}, calls)

        def fake_download(**kwargs):
            target = Path(kwargs["dest_dir"]) / kwargs["filename"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"shared")
            return target.stat().st_size

        async def run():
            with patch.object(model_router, "_download_file_streamed", fake_download):
                response = await model_router.hf_download_sources(
                    request_for([SOURCES[0]]), "pixal3d/_shared/base"
                )
                return await collect_events(response)

        events = asyncio.run(run())
        self.assertEqual(events[-1], {"percent": 100, "status": "done"})
        self.assertTrue(
            (self.models_dir / "pixal3d/_shared/base/main.bin").is_file()
        )

    def test_rejects_a_check_filtered_out_of_the_source_plan(self) -> None:
        self.registry_sources = [SOURCES[0]]
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["other.bin"]}, calls)

        async def run():
            response = await model_router.hf_download_sources(
                request_for([SOURCES[0]]), "pixal3d/generate"
            )
            return await collect_events(response)

        events = asyncio.run(run())
        self.assertIn("excluded from its download plan", events[-1]["error"]["message"])
        self.assertEqual(events[-1]["error"]["code"], "source_plan_invalid")
        self.assertEqual(events[-1]["error"]["stage"], "validate")
        self.assertIs(events[-1]["error"]["retryable"], False)
        self.assertFalse((self.models_dir / "pixal3d/generate/other.bin").exists())

    def test_download_uses_live_storage_after_settings_update(self):
        self.registry_sources = [SOURCES[0]]
        calls = []
        self.install_hf_stub({"org/main": ["main.bin"]}, calls)
        relocated = self.models_dir.parent / "relocated"
        registry = model_router.registry_module.GeneratorRegistry()
        registry.update_paths(relocated, None)

        def fake_download(**kwargs):
            target = Path(kwargs["dest_dir"]) / kwargs["filename"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"complete")
            return target.stat().st_size

        async def run():
            with patch.object(model_router, "_download_file_streamed", fake_download):
                for target_id in ("pixal3d/generate", "pixal3d/_shared/base"):
                    response = await model_router.hf_download_sources(request_for([SOURCES[0]]), target_id)
                    await collect_events(response)
                    self.assertTrue((relocated / target_id / "main.bin").is_file())
                    self.assertFalse((self.models_dir / target_id).exists())
        asyncio.run(run())

    def test_removal_unload_requires_confirmed_process_stop(self):
        from unittest.mock import Mock
        from services.extension_process import ExtensionProcess
        registry = model_router.registry_module.GeneratorRegistry()
        gen = Mock(spec=ExtensionProcess)
        registry._generators["demo/a"] = gen
        try:
            with patch.object(model_router, "generator_registry", registry):
                self.assertEqual(asyncio.run(model_router.unload_model("demo/a")), {"unloaded": True})
                gen.stop.assert_called_once()
                gen.unload.assert_not_called()
                gen.stop.side_effect = RuntimeError("still running")
                with self.assertRaisesRegex(RuntimeError, "still running"):
                    asyncio.run(model_router.unload_model("demo/a"))
                self.assertEqual(gen.stop.call_count, 2)
                gen.unload.assert_not_called()
        finally:
            registry._runtime_readiness_executor.shutdown(wait=True)

    def test_removal_rejects_direct_generator_that_remains_loaded(self):
        from unittest.mock import Mock
        from fastapi import HTTPException
        registry = model_router.registry_module.GeneratorRegistry()
        gen = Mock()
        gen.is_loaded.return_value = True
        registry._generators["demo/a"] = gen
        try:
            with patch.object(model_router, "generator_registry", registry):
                with self.assertRaises(HTTPException) as error:
                    asyncio.run(model_router.unload_model("demo/a"))
                self.assertEqual(error.exception.status_code, 409)
                gen.unload.assert_called_once()
                self.assertIs(registry._generators["demo/a"], gen)
        finally:
            registry._runtime_readiness_executor.shutdown(wait=True)

    def test_composite_model_unload_route_uses_path_converter(self) -> None:
        paths = {route.path for route in model_router.router.routes}
        self.assertIn("/unload/{model_id:path}", paths)
        self.assertEqual(model_router.Request.__module__, "urllib.request")

    def test_rejects_an_unsafe_remote_filename_before_download(self) -> None:
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["../escape.bin"]}, calls)
        self.registry_sources = [SOURCES[0]]

        async def run():
            response = await model_router.hf_download_sources(
                request_for(), "pixal3d/generate"
            )
            return await collect_events(response)

        events = asyncio.run(run())
        failure = events[-1]["error"]
        self.assertEqual(failure["code"], "source_plan_invalid")
        self.assertEqual(failure["stage"], "validate")
        self.assertIn("unsafe", failure["message"])
        self.assertIs(failure["retryable"], False)
        self.assertFalse(any(call.startswith("download:") for call in calls))
        self.assertFalse((self.models_dir / "pixal3d/escape.bin").exists())

    def test_structures_invalid_manifest_destination_before_listing(self) -> None:
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["main.bin"]}, calls)
        self.registry_sources = [{**SOURCES[0], "destination": "../outside"}]

        async def run():
            response = await model_router.hf_download_sources(
                request_for(), "pixal3d/generate"
            )
            return await collect_events(response)

        events = asyncio.run(run())
        failure = events[-1]["error"]
        self.assertEqual(failure["code"], "source_plan_invalid")
        self.assertEqual(failure["stage"], "validate")
        self.assertIs(failure["retryable"], False)
        self.assertIn("unsafe", failure["message"])
        self.assertFalse(calls)

    def test_rejects_existing_files_in_model_root_path_before_listing(self) -> None:
        self.registry_sources = [SOURCES[0]]
        (self.models_dir / "pixal3d").mkdir()
        (self.models_dir / "pixal3d" / "generate").write_bytes(b"not-a-directory")

        async def run():
            response = await model_router.hf_download_sources(
                request_for(), "pixal3d/generate"
            )
            return await collect_events(response)

        failure = asyncio.run(run())[-1]["error"]
        self.assertEqual(failure["code"], "source_plan_invalid")
        self.assertEqual(failure["stage"], "validate")
        self.assertIs(failure["retryable"], False)

    def test_rejects_existing_files_in_destination_ancestors_before_listing(self) -> None:
        self.registry_sources = [{**SOURCES[0], "destination": "auxiliary/encoder"}]
        model_root = self.models_dir / "pixal3d" / "generate"
        model_root.mkdir(parents=True)
        (model_root / "auxiliary").write_bytes(b"not-a-directory")

        async def run():
            response = await model_router.hf_download_sources(
                request_for(), "pixal3d/generate"
            )
            return await collect_events(response)

        failure = asyncio.run(run())[-1]["error"]
        self.assertEqual(failure["code"], "source_plan_invalid")
        self.assertEqual(failure["stage"], "validate")
        self.assertIs(failure["retryable"], False)

    def test_structures_filter_that_removes_every_file_as_invalid_plan(self) -> None:
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["main.bin"]}, calls)
        self.registry_sources = [{**SOURCES[0], "include_prefixes": ["missing/"]}]

        async def run():
            response = await model_router.hf_download_sources(
                request_for(), "pixal3d/generate"
            )
            return await collect_events(response)

        events = asyncio.run(run())
        failure = events[-1]["error"]
        self.assertEqual(failure["code"], "source_plan_invalid")
        self.assertEqual(failure["stage"], "validate")
        self.assertIs(failure["retryable"], False)
        self.assertIn("No files remain", failure["message"])
        self.assertFalse(any(call.startswith("download:") for call in calls))

    def test_rejects_portable_target_collision_in_the_source_plan(self) -> None:
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["auxiliary"], "org/encoder": ["encoder.bin"]}, calls)
        self.registry_sources = [
            {**SOURCES[0], "checks": ["auxiliary"]},
            {**SOURCES[1], "destination": "auxiliary", "checks": ["encoder.bin"]},
        ]

        async def run():
            response = await model_router.hf_download_sources(
                request_for(), "pixal3d/generate"
            )
            return await collect_events(response)

        events = asyncio.run(run())
        failure = events[-1]["error"]
        self.assertEqual(failure["code"], "source_plan_invalid")
        self.assertEqual(failure["stage"], "validate")
        self.assertIn("portable target collision", failure["message"])
        self.assertIs(failure["retryable"], False)
        self.assertFalse((self.models_dir / "pixal3d/generate/auxiliary").exists())

    def test_preserves_structured_source_file_failure(self) -> None:
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["main.bin"]}, calls)
        self.registry_sources = [SOURCES[0]]

        def fake_download(**kwargs):
            raise RuntimeError("network timeout")

        async def run():
            with patch.object(model_router, "_download_file_streamed", fake_download):
                response = await model_router.hf_download_sources(
                    request_for(), "pixal3d/generate"
                )
                return await collect_events(response)

        events = asyncio.run(run())
        self.assertEqual(events[-1]["error"]["code"], "source_file_failed")
        self.assertEqual(events[-1]["error"]["repo_id"], "org/main")
        self.assertEqual(events[-1]["error"]["file"], "main.bin")

    def test_rejects_request_body_sources_when_they_do_not_match_manifest(self) -> None:
        requested = [{**SOURCES[0], "repo_id": "other/unregistered"}]
        self.registry_sources = [SOURCES[0]]

        async def run():
            with self.assertRaises(model_router.HTTPException) as raised:
                await model_router.hf_download_sources(
                    request_for(requested), "pixal3d/generate"
                )
            return raised.exception

        exc = asyncio.run(run())
        self.assertEqual(exc.status_code, 400)
        self.assertIn("match", str(exc.detail))

    def test_rejects_mismatched_target_owner_identity(self) -> None:
        async def run():
            with self.assertRaises(model_router.HTTPException) as raised:
                await model_router.hf_download_sources(
                    request_for(), "pixal3d/generate", target_owner_id="pixal3d/other"
                )
            return raised.exception

        exc = asyncio.run(run())
        self.assertEqual(exc.status_code, 400)
        self.assertEqual(exc.detail["code"], "target_owner_mismatch")
        self.assertEqual(exc.detail["stage"], "request")
        self.assertIs(exc.detail["retryable"], False)
        self.assertIn("Target owner", exc.detail["message"])

    def test_rejects_second_download_for_active_owner_control(self) -> None:
        self.registry_sources = [SOURCES[0]]
        model_router._download_controls["pixal3d/generate"] = {
            "pause": threading.Event(),
            "cancel": threading.Event(),
        }

        async def run():
            with self.assertRaises(model_router.HTTPException) as raised:
                await model_router.hf_download_sources(
                    request_for(), "pixal3d/generate"
                )
            return raised.exception

        exc = asyncio.run(run())
        self.assertEqual(exc.status_code, 409)
        self.assertEqual(exc.detail["code"], "download_in_progress")

    def test_legacy_invalid_plan_http_error_preserves_structured_validation_detail(self) -> None:
        class LegacyRegistry:
            def get_legacy_hf_download_plan(self, _model_id):
                raise ValueError("legacy hf plan is malformed")

        old_registry = model_router.generator_registry
        model_router.generator_registry = LegacyRegistry()
        try:
            with self.assertRaises(model_router.HTTPException) as raised:
                asyncio.run(model_router.hf_download(model_id="pixal3d/generate"))
            self.assertEqual(raised.exception.status_code, 422)
            self.assertEqual(raised.exception.detail["code"], "source_plan_invalid")
            self.assertEqual(raised.exception.detail["stage"], "validate")
            self.assertIs(raised.exception.detail["retryable"], False)
        finally:
            model_router.generator_registry = old_registry

    def test_legacy_owner_path_is_confined_before_streaming(self) -> None:
        class LegacyRegistry:
            def get_legacy_hf_download_plan(self, _model_id):
                return {"repo_id": "org/model", "hf_skip_prefixes": [], "hf_include_prefixes": []}

            def get_manifest(self, _model_id):
                return {}

            def canonical_model_dir(self, _model_id):
                return self.models_dir / "demo" / "../outside"

        old_registry = model_router.generator_registry
        model_router.generator_registry = LegacyRegistry()
        model_router.generator_registry.models_dir = self.models_dir
        try:
            with self.assertRaises(model_router.HTTPException) as raised:
                asyncio.run(model_router.hf_download(model_id="demo/generate"))
            self.assertEqual(raised.exception.status_code, 422)
            self.assertFalse((self.models_dir.parent / "outside").exists())
            self.assertIs(raised.exception.detail["retryable"], False)
        finally:
            model_router.generator_registry = old_registry

    def test_https_invalid_plan_http_error_preserves_structured_validation_detail(self) -> None:
        class HttpsRegistry:
            def get_https_download_plan(self, _model_id):
                raise model_router.HttpsDownloadManifestError("https plan is malformed")

        old_registry = model_router.generator_registry
        model_router.generator_registry = HttpsRegistry()
        try:
            with self.assertRaises(model_router.HTTPException) as raised:
                asyncio.run(model_router.https_download_assets(model_id="pixal3d/generate"))
            self.assertEqual(raised.exception.status_code, 422)
            self.assertEqual(raised.exception.detail["code"], "source_plan_invalid")
            self.assertEqual(raised.exception.detail["stage"], "validate")
            self.assertIs(raised.exception.detail["retryable"], False)
        finally:
            model_router.generator_registry = old_registry



class ModelLifecycleEndpointTests(unittest.TestCase):
    def test_status_and_switch_do_not_block_the_event_loop_while_lifecycle_is_contended(self) -> None:
        class ContendedRegistry:
            def __init__(self):
                self.lock = threading.Lock()
            def active_status(self):
                with self.lock:
                    return {"id": "demo/a", "loaded": True}
            def switch_model(self, model_id):
                with self.lock:
                    return None

        registry = ContendedRegistry()
        previous = model_router.generator_registry
        model_router.generator_registry = registry

        async def assert_responsive(call):
            registry.lock.acquire()
            release = threading.Timer(0.25, registry.lock.release)
            release.start()
            try:
                start = asyncio.get_running_loop().time()
                task = asyncio.create_task(call())
                await asyncio.sleep(0.02)
                elapsed = asyncio.get_running_loop().time() - start
                self.assertLess(elapsed, 0.15)
                return await task
            finally:
                release.join()

        async def run():
            status = await assert_responsive(model_router.model_status)
            switched = await assert_responsive(lambda: model_router.switch_model("demo/b"))
            return status, switched

        try:
            status, switched = asyncio.run(run())
        finally:
            model_router.generator_registry = previous

        self.assertEqual(status["id"], "demo/a")
        self.assertEqual(switched, {"active": "demo/b"})


if __name__ == "__main__":
    unittest.main()
