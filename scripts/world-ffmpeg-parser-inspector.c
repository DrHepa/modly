#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavcodec/version_major.h>

#ifdef _WIN32
#include <windows.h>
typedef HMODULE LibraryHandle;

static LibraryHandle open_exact_library(const char *path) {
    int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
    if (required < 2 || required > 32767) return NULL;
    wchar_t *wide = calloc((size_t)required, sizeof(*wide));
    if (!wide) return NULL;
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, required) != required) {
        free(wide);
        return NULL;
    }
    LibraryHandle handle = LoadLibraryExW(wide, NULL,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    free(wide);
    return handle;
}

static void *required_symbol(LibraryHandle handle, const char *name) {
    return (void *)GetProcAddress(handle, name);
}

static void close_library(LibraryHandle handle) { FreeLibrary(handle); }
#else
#include <dlfcn.h>
typedef void *LibraryHandle;

static LibraryHandle open_exact_library(const char *path) {
    return dlopen(path, RTLD_NOW | RTLD_LOCAL);
}

static void *required_symbol(LibraryHandle handle, const char *name) {
    return dlsym(handle, name);
}

static void close_library(LibraryHandle handle) { dlclose(handle); }
#endif

typedef const AVCodecParser *(*ParserIterate)(void **);
typedef const char *(*CodecName)(enum AVCodecID);
typedef unsigned (*CodecVersion)(void);

int main(int argc, char **argv) {
    if (argc != 2 || !argv[1]) {
        fputs("Expected an absolute staged libavcodec path.\n", stderr);
        return 2;
    }
    int absolute = argv[1][0] == '/';
#ifdef _WIN32
    absolute = absolute || (strlen(argv[1]) > 2 && argv[1][1] == ':' &&
        (argv[1][2] == '\\' || argv[1][2] == '/')) ||
        (argv[1][0] == '\\' && argv[1][1] == '\\');
#endif
    if (!absolute) {
        fputs("Expected an absolute staged libavcodec path.\n", stderr);
        return 2;
    }
    LibraryHandle library = open_exact_library(argv[1]);
    if (!library) {
        fputs("Could not open the exact staged libavcodec.\n", stderr);
        return 3;
    }
    ParserIterate iterate = (ParserIterate)required_symbol(library, "av_parser_iterate");
    CodecName codec_name = (CodecName)required_symbol(library, "avcodec_get_name");
    CodecVersion codec_version = (CodecVersion)required_symbol(library, "avcodec_version");
    if (!iterate || !codec_name || !codec_version || (codec_version() >> 16) != LIBAVCODEC_VERSION_MAJOR) {
        fputs("Required staged libavcodec parser symbols or version are unavailable.\n", stderr);
        close_library(library);
        return 4;
    }
    void *opaque = NULL;
    const AVCodecParser *parser;
    unsigned count = 0;
    while ((parser = iterate(&opaque)) != NULL) {
        if (++count > 256) {
            fputs("Too many staged libavcodec parsers.\n", stderr);
            close_library(library);
            return 5;
        }
        unsigned codec_count = 0;
        for (size_t index = 0; index < sizeof(parser->codec_ids) / sizeof(parser->codec_ids[0]); ++index) {
            int id = parser->codec_ids[index];
            if (id == AV_CODEC_ID_NONE) break;
            const char *name = codec_name((enum AVCodecID)id);
            if (!name || !*name || strlen(name) > 64 || strspn(name, "abcdefghijklmnopqrstuvwxyz0123456789_") != strlen(name)) {
                fputs("Staged libavcodec parser has an invalid codec name.\n", stderr);
                close_library(library);
                return 6;
            }
            puts(name);
            codec_count++;
        }
        if (!codec_count) {
            fputs("Staged libavcodec parser has no codec identity.\n", stderr);
            close_library(library);
            return 7;
        }
    }
    if (!count) {
        fputs("Staged libavcodec has no parsers.\n", stderr);
        close_library(library);
        return 8;
    }
    close_library(library);
    return 0;
}
