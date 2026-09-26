import asyncio
import os
import unittest
from unittest.mock import patch

from routers.status import health


class HealthIdentityTests(unittest.TestCase):
    def test_health_preserves_legacy_response_without_bridge_launch_id(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(asyncio.run(health()), {"status": "ok"})

    def test_health_echoes_bridge_launch_id_for_owned_process_check(self):
        with patch.dict(os.environ, {"MODLY_BRIDGE_LAUNCH_ID": "owned-test-launch"}):
            self.assertEqual(
                asyncio.run(health()),
                {"status": "ok", "bridge_instance": "owned-test-launch"},
            )
