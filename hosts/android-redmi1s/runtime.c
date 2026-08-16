#include "pocket_runtime.h"

#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <android/asset_manager.h>
#include <android/input.h>
#include <android/log.h>
#include <android/native_activity.h>
#include <android/window.h>
#include <android_native_app_glue.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#ifndef POCKET_BUILD_ID
#define POCKET_BUILD_ID "unknown"
#endif
#ifndef POCKET_LOGICAL_WIDTH
#error "POCKET_LOGICAL_WIDTH must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKET_LOGICAL_HEIGHT
#error "POCKET_LOGICAL_HEIGHT must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKET_PHYSICAL_WIDTH
#error "POCKET_PHYSICAL_WIDTH must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKET_PHYSICAL_HEIGHT
#error "POCKET_PHYSICAL_HEIGHT must come from the verified ResolvedBuildPlan"
#endif

#define POCKET_TAG "PocketJS-Redmi1S"
#define POCKET_STATUS_FILE "status.txt"
#define POCKET_CAPTURE_FILE "frame.rgba"
#define POCKET_STATUS_HEARTBEAT_FRAMES 60U
#define POCKET_CAPTURE_FRAME 120U
#define POCKET_TICK_US 16667ULL
#define POCKET_PATH_CAPACITY 512
#define POCKET_TEXT_CAPACITY 256

typedef struct {
  struct android_app *app;
  EGLDisplay display;
  EGLSurface surface;
  EGLContext context;
  int32_t surface_width;
  int32_t surface_height;
  int focused;
  int runtime_ready;
  int gl_ready;
  int failed;
  int touch_down;
  int touch_x;
  int touch_y;
  int touch_hit;
  int touch_needs_hit;
  int touch_was_sent;
  int touch_release_after_frame;
  int touch_awaiting_completion;
  uint8_t *java_script;
  size_t java_script_length;
  uint8_t *pack;
  size_t pack_length;
  uint64_t guest_frames;
  uint64_t swaps;
  uint64_t touch_sequences;
  uint64_t completed_touch_sequences;
  uint64_t capture_successes;
  uint64_t capture_hash;
  uint64_t frame_us_total;
  uint64_t swap_us_total;
  uint64_t last_frame_us;
  uint64_t observed_action_sequence;
  char state[32];
  char error[POCKET_TEXT_CAPACITY];
  char gl_vendor[POCKET_TEXT_CAPACITY];
  char gl_renderer[POCKET_TEXT_CAPACITY];
  char gl_version[POCKET_TEXT_CAPACITY];
  char gl_shading_language[POCKET_TEXT_CAPACITY];
} PocketHost;

static uint64_t now_us(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
  return (uint64_t)value.tv_sec * 1000000ULL + (uint64_t)value.tv_nsec / 1000ULL;
}

static void copy_text(char *target, size_t capacity, const char *source) {
  size_t index = 0;
  if (capacity == 0) return;
  if (source != NULL) {
    while (index + 1 < capacity && source[index] != '\0') {
      char value = source[index];
      target[index] = value == '\n' || value == '\r' ? ' ' : value;
      index += 1;
    }
  }
  target[index] = '\0';
}

static const char *gl_text(GLenum name) {
  const GLubyte *value = glGetString(name);
  return value == NULL ? "unavailable" : (const char *)value;
}

static int data_path(PocketHost *host, const char *name, char *path, size_t capacity) {
  const char *root = host->app->activity->internalDataPath;
  int written;
  if (root == NULL) return 0;
  written = snprintf(path, capacity, "%s/%s", root, name);
  return written >= 0 && (size_t)written < capacity;
}

static void write_status(PocketHost *host) {
  char path[POCKET_PATH_CAPACITY];
  char temporary[POCKET_PATH_CAPACITY];
  FILE *file;
  const char *action_name = host->runtime_ready ? pocket_runtime_action_name() : "";
  int action_value = host->runtime_ready ? pocket_runtime_action_value() : 0;
  unsigned long action_sequence = host->runtime_ready ? pocket_runtime_action_sequence() : 0;
  uint64_t mean_frame_us = host->guest_frames == 0 ? 0 : host->frame_us_total / host->guest_frames;
  uint64_t mean_swap_us = host->swaps == 0 ? 0 : host->swap_us_total / host->swaps;
  int written;
  if (!data_path(host, POCKET_STATUS_FILE, path, sizeof(path))) return;
  written = snprintf(temporary, sizeof(temporary), "%s.new", path);
  if (written < 0 || (size_t)written >= sizeof(temporary)) return;
  file = fopen(temporary, "wb");
  if (file == NULL) return;
  fprintf(file,
    "schema=1\n"
    "build_id=%s\n"
    "state=%s\n"
    "renderer=%s\n"
    "logical_viewport=%dx%d\n"
    "physical_viewport=%dx%d\n"
    "surface=%dx%d\n"
    "guest_frames=%" PRIu64 "\n"
    "swaps=%" PRIu64 "\n"
    "mean_frame_us=%" PRIu64 "\n"
    "mean_swap_us=%" PRIu64 "\n"
    "touch_sequences=%" PRIu64 "\n"
    "completed_touch_sequences=%" PRIu64 "\n"
    "touch_down=%d\n"
    "last_touch_x=%d\n"
    "last_touch_y=%d\n"
    "last_touch_hit=%d\n"
    "action_name=%s\n"
    "action_value=%d\n"
    "action_sequence=%lu\n"
    "capture_successes=%" PRIu64 "\n"
    "capture_hash=%016" PRIx64 "\n"
    "gl_vendor=%s\n"
    "gl_renderer=%s\n"
    "gl_version=%s\n"
    "gl_shading_language=%s\n"
    "written_at_us=%" PRIu64 "\n"
    "error=%s\n",
    POCKET_BUILD_ID,
    host->state,
    host->gl_ready ? "gles2" : "none",
    POCKET_LOGICAL_WIDTH,
    POCKET_LOGICAL_HEIGHT,
    POCKET_PHYSICAL_WIDTH,
    POCKET_PHYSICAL_HEIGHT,
    host->surface_width,
    host->surface_height,
    host->guest_frames,
    host->swaps,
    mean_frame_us,
    mean_swap_us,
    host->touch_sequences,
    host->completed_touch_sequences,
    host->touch_down,
    host->touch_x,
    host->touch_y,
    host->touch_hit,
    action_name == NULL ? "" : action_name,
    action_value,
    action_sequence,
    host->capture_successes,
    host->capture_hash,
    host->gl_vendor,
    host->gl_renderer,
    host->gl_version,
    host->gl_shading_language,
    now_us(),
    host->error
  );
  if (fclose(file) == 0) (void)rename(temporary, path);
}

static void fail_host(PocketHost *host, const char *message) {
  if (host->failed) return;
  host->failed = 1;
  copy_text(host->state, sizeof(host->state), "failed");
  copy_text(host->error, sizeof(host->error), message);
  __android_log_print(ANDROID_LOG_ERROR, POCKET_TAG, "%s", host->error);
  write_status(host);
}

static uint8_t *load_asset(
  PocketHost *host,
  const char *name,
  size_t *length,
  int terminate
) {
  AAsset *asset = AAssetManager_open(host->app->activity->assetManager, name, AASSET_MODE_BUFFER);
  off_t expected;
  uint8_t *bytes;
  size_t offset = 0;
  if (asset == NULL) return NULL;
  expected = AAsset_getLength(asset);
  if (expected < 0 || (uint64_t)expected > (uint64_t)SIZE_MAX - (terminate ? 1U : 0U)) {
    AAsset_close(asset);
    return NULL;
  }
  bytes = (uint8_t *)malloc((size_t)expected + (terminate ? 1U : 0U));
  if (bytes == NULL) {
    AAsset_close(asset);
    return NULL;
  }
  while (offset < (size_t)expected) {
    int count = AAsset_read(asset, bytes + offset, (size_t)expected - offset);
    if (count <= 0) {
      free(bytes);
      AAsset_close(asset);
      return NULL;
    }
    offset += (size_t)count;
  }
  AAsset_close(asset);
  if (terminate) bytes[offset] = 0;
  *length = offset;
  return bytes;
}

static int boot_guest(PocketHost *host) {
  if (host->runtime_ready) return 1;
  host->java_script = load_asset(host, "app.js", &host->java_script_length, 1);
  host->pack = load_asset(host, "app.pak", &host->pack_length, 0);
  if (host->java_script == NULL || host->pack == NULL) {
    fail_host(host, "APK is missing app.js or app.pak");
    return 0;
  }
  if (!pocket_runtime_boot(
        (const char *)host->java_script,
        host->java_script_length,
        host->pack,
        host->pack_length,
        POCKET_LOGICAL_WIDTH,
        POCKET_LOGICAL_HEIGHT
      )) {
    fail_host(host, pocket_runtime_error());
    return 0;
  }
  host->runtime_ready = 1;
  return 1;
}

static void destroy_egl(PocketHost *host) {
  if (host->display != EGL_NO_DISPLAY && host->context != EGL_NO_CONTEXT) {
    (void)eglMakeCurrent(host->display, host->surface, host->surface, host->context);
    if (host->gl_ready) pocket_runtime_gl_shutdown();
  }
  host->gl_ready = 0;
  if (host->display != EGL_NO_DISPLAY) {
    (void)eglMakeCurrent(host->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (host->context != EGL_NO_CONTEXT) (void)eglDestroyContext(host->display, host->context);
    if (host->surface != EGL_NO_SURFACE) (void)eglDestroySurface(host->display, host->surface);
    (void)eglTerminate(host->display);
  }
  host->display = EGL_NO_DISPLAY;
  host->surface = EGL_NO_SURFACE;
  host->context = EGL_NO_CONTEXT;
  host->surface_width = 0;
  host->surface_height = 0;
}

static int create_egl(PocketHost *host) {
  const EGLint config_attributes[] = {
    EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
    EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
    EGL_RED_SIZE, 8,
    EGL_GREEN_SIZE, 8,
    EGL_BLUE_SIZE, 8,
    EGL_ALPHA_SIZE, 8,
    EGL_DEPTH_SIZE, 0,
    EGL_NONE
  };
  const EGLint context_attributes[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
  EGLConfig config;
  EGLint count = 0;
  EGLint format = 0;
  EGLint major = 0;
  EGLint minor = 0;
  if (host->app->window == NULL) return 0;
  destroy_egl(host);
  host->display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  if (host->display == EGL_NO_DISPLAY || !eglInitialize(host->display, &major, &minor)) {
    fail_host(host, "eglInitialize failed");
    return 0;
  }
  if (!eglChooseConfig(host->display, config_attributes, &config, 1, &count) || count != 1) {
    fail_host(host, "no RGBA8 GLES2 window configuration");
    destroy_egl(host);
    return 0;
  }
  if (!eglGetConfigAttrib(host->display, config, EGL_NATIVE_VISUAL_ID, &format)) {
    fail_host(host, "EGL_NATIVE_VISUAL_ID is unavailable");
    destroy_egl(host);
    return 0;
  }
  if (ANativeWindow_setBuffersGeometry(host->app->window, 0, 0, format) != 0) {
    fail_host(host, "ANativeWindow buffer geometry failed");
    destroy_egl(host);
    return 0;
  }
  host->surface = eglCreateWindowSurface(host->display, config, host->app->window, NULL);
  host->context = eglCreateContext(host->display, config, EGL_NO_CONTEXT, context_attributes);
  if (host->surface == EGL_NO_SURFACE || host->context == EGL_NO_CONTEXT ||
      !eglMakeCurrent(host->display, host->surface, host->surface, host->context)) {
    fail_host(host, "GLES2 context creation failed");
    destroy_egl(host);
    return 0;
  }
  if (!eglQuerySurface(host->display, host->surface, EGL_WIDTH, &host->surface_width) ||
      !eglQuerySurface(host->display, host->surface, EGL_HEIGHT, &host->surface_height)) {
    fail_host(host, "EGL surface size is unavailable");
    destroy_egl(host);
    return 0;
  }
  if (host->surface_width != POCKET_PHYSICAL_WIDTH || host->surface_height != POCKET_PHYSICAL_HEIGHT) {
    fail_host(host, "EGL surface does not match the verified 720x1280 display");
    destroy_egl(host);
    return 0;
  }
  if (!boot_guest(host)) {
    destroy_egl(host);
    return 0;
  }
  if (!pocket_runtime_gl_initialize()) {
    fail_host(host, "PocketJS GLES2 DrawList backend initialization failed");
    destroy_egl(host);
    return 0;
  }
  if (!eglSwapInterval(host->display, 1)) {
    fail_host(host, "eglSwapInterval(1) failed");
    destroy_egl(host);
    return 0;
  }
  copy_text(host->gl_vendor, sizeof(host->gl_vendor), gl_text(GL_VENDOR));
  copy_text(host->gl_renderer, sizeof(host->gl_renderer), gl_text(GL_RENDERER));
  copy_text(host->gl_version, sizeof(host->gl_version), gl_text(GL_VERSION));
  copy_text(host->gl_shading_language, sizeof(host->gl_shading_language),
    gl_text(GL_SHADING_LANGUAGE_VERSION));
  host->gl_ready = 1;
  host->last_frame_us = now_us();
  copy_text(host->state, sizeof(host->state), "running");
  copy_text(host->error, sizeof(host->error), "");
  __android_log_print(
    ANDROID_LOG_INFO,
    POCKET_TAG,
    "GLES2 ready: %s / %s / %s",
    host->gl_vendor,
    host->gl_renderer,
    host->gl_version
  );
  write_status(host);
  return 1;
}

static void update_touch(PocketHost *host, AInputEvent *event, size_t index) {
  float x = AMotionEvent_getX(event, index);
  float y = AMotionEvent_getY(event, index);
  int logical_x = host->surface_width <= 0 ? 0 :
    (int)(x * (float)POCKET_LOGICAL_WIDTH / (float)host->surface_width);
  int logical_y = host->surface_height <= 0 ? 0 :
    (int)(y * (float)POCKET_LOGICAL_HEIGHT / (float)host->surface_height);
  if (logical_x < 0) logical_x = 0;
  if (logical_y < 0) logical_y = 0;
  if (logical_x >= POCKET_LOGICAL_WIDTH) logical_x = POCKET_LOGICAL_WIDTH - 1;
  if (logical_y >= POCKET_LOGICAL_HEIGHT) logical_y = POCKET_LOGICAL_HEIGHT - 1;
  host->touch_x = logical_x;
  host->touch_y = logical_y;
}

static void begin_touch(PocketHost *host) {
  host->touch_down = 1;
  host->touch_sequences += 1;
  host->touch_was_sent = 0;
  host->touch_release_after_frame = 0;
  host->touch_awaiting_completion = 0;
  if (host->runtime_ready) {
    host->touch_hit = pocket_runtime_hit_test_bounds((float)host->touch_x, (float)host->touch_y);
    host->touch_needs_hit = 0;
  } else {
    host->touch_hit = 0;
    host->touch_needs_hit = 1;
  }
}

static void end_touch(PocketHost *host) {
  if (!host->touch_down) return;
  host->touch_awaiting_completion = 1;
  if (host->touch_was_sent) {
    host->touch_down = 0;
    host->touch_hit = 0;
    host->touch_needs_hit = 0;
  } else {
    host->touch_release_after_frame = 1;
  }
}

static int32_t on_input(struct android_app *app, AInputEvent *event) {
  PocketHost *host = (PocketHost *)app->userData;
  int32_t action;
  int32_t masked;
  size_t index;
  if (host == NULL || AInputEvent_getType(event) != AINPUT_EVENT_TYPE_MOTION) return 0;
  action = AMotionEvent_getAction(event);
  masked = action & AMOTION_EVENT_ACTION_MASK;
  index = (size_t)((action & AMOTION_EVENT_ACTION_POINTER_INDEX_MASK) >>
    AMOTION_EVENT_ACTION_POINTER_INDEX_SHIFT);
  if (index >= AMotionEvent_getPointerCount(event)) index = 0;
  if (masked == AMOTION_EVENT_ACTION_DOWN) {
    update_touch(host, event, index);
    begin_touch(host);
  } else if (masked == AMOTION_EVENT_ACTION_MOVE && host->touch_down) {
    update_touch(host, event, 0);
  } else if ((masked == AMOTION_EVENT_ACTION_UP || masked == AMOTION_EVENT_ACTION_CANCEL) &&
      host->touch_down) {
    update_touch(host, event, index);
    end_touch(host);
  }
  return 1;
}

static void on_command(struct android_app *app, int32_t command) {
  PocketHost *host = (PocketHost *)app->userData;
  if (host == NULL) return;
  switch (command) {
    case APP_CMD_INIT_WINDOW:
      if (!host->failed) (void)create_egl(host);
      break;
    case APP_CMD_TERM_WINDOW:
      destroy_egl(host);
      if (!host->failed) copy_text(host->state, sizeof(host->state), "surface-lost");
      write_status(host);
      break;
    case APP_CMD_GAINED_FOCUS:
      host->focused = 1;
      break;
    case APP_CMD_LOST_FOCUS:
      host->focused = 0;
      write_status(host);
      break;
    case APP_CMD_WINDOW_RESIZED:
      if (host->gl_ready) {
        (void)eglQuerySurface(host->display, host->surface, EGL_WIDTH, &host->surface_width);
        (void)eglQuerySurface(host->display, host->surface, EGL_HEIGHT, &host->surface_height);
      }
      break;
    default:
      break;
  }
}

static uint64_t fnv1a64(const uint8_t *bytes, size_t length) {
  uint64_t hash = 1469598103934665603ULL;
  size_t index;
  for (index = 0; index < length; index += 1) {
    hash ^= bytes[index];
    hash *= 1099511628211ULL;
  }
  return hash;
}

static void capture_frame(PocketHost *host) {
  char path[POCKET_PATH_CAPACITY];
  size_t length;
  uint8_t *pixels;
  FILE *file;
  size_t written;
  int closed;
  if (host->capture_successes != 0 || !host->gl_ready) return;
  length = (size_t)host->surface_width * (size_t)host->surface_height * 4U;
  pixels = (uint8_t *)malloc(length);
  if (pixels == NULL) return;
  glFinish();
  glReadPixels(0, 0, host->surface_width, host->surface_height, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
  if (glGetError() != GL_NO_ERROR || !data_path(host, POCKET_CAPTURE_FILE, path, sizeof(path))) {
    free(pixels);
    return;
  }
  file = fopen(path, "wb");
  if (file == NULL) {
    free(pixels);
    return;
  }
  written = fwrite(pixels, 1, length, file);
  closed = fclose(file);
  if (written == length && closed == 0) {
    host->capture_hash = fnv1a64(pixels, length);
    host->capture_successes = 1;
  }
  free(pixels);
}

static void render_frame(PocketHost *host) {
  uint64_t started = now_us();
  uint64_t elapsed = host->last_frame_us == 0 || started <= host->last_frame_us
    ? POCKET_TICK_US
    : started - host->last_frame_us;
  unsigned int ticks = (unsigned int)((elapsed + POCKET_TICK_US / 2U) / POCKET_TICK_US);
  int delivered_touch;
  int completed_touch;
  uint64_t swap_started;
  if (ticks < 1U) ticks = 1U;
  if (ticks > 4U) ticks = 4U;
  host->last_frame_us = started;
  if (host->touch_down && host->touch_needs_hit) {
    host->touch_hit = pocket_runtime_hit_test_bounds((float)host->touch_x, (float)host->touch_y);
    host->touch_needs_hit = 0;
  }
  delivered_touch = host->touch_down;
  if (!pocket_runtime_frame_ticks(
        host->touch_down,
        host->touch_x,
        host->touch_y,
        host->touch_hit,
        ticks
      )) {
    fail_host(host, pocket_runtime_error());
    return;
  }
  if (delivered_touch) host->touch_was_sent = 1;
  if (host->touch_release_after_frame) {
    host->touch_down = 0;
    host->touch_hit = 0;
    host->touch_needs_hit = 0;
    host->touch_release_after_frame = 0;
  }
  completed_touch = !delivered_touch && host->touch_awaiting_completion;
  if (completed_touch) {
    host->completed_touch_sequences += 1;
    host->touch_awaiting_completion = 0;
  }
  if (!pocket_runtime_gl_render(host->surface_width, host->surface_height)) {
    fail_host(host, "PocketJS GLES2 DrawList render failed");
    return;
  }
  host->guest_frames += 1;
  if (host->guest_frames == POCKET_CAPTURE_FRAME) capture_frame(host);
  swap_started = now_us();
  if (!eglSwapBuffers(host->display, host->surface)) {
    fail_host(host, "eglSwapBuffers failed");
    return;
  }
  host->swaps += 1;
  host->frame_us_total += swap_started - started;
  host->swap_us_total += now_us() - swap_started;
  if (host->guest_frames == 1 || completed_touch ||
      pocket_runtime_action_sequence() != host->observed_action_sequence ||
      host->guest_frames % POCKET_STATUS_HEARTBEAT_FRAMES == 0) {
    host->observed_action_sequence = pocket_runtime_action_sequence();
    write_status(host);
  }
}

void android_main(struct android_app *app) {
  PocketHost host;
  memset(&host, 0, sizeof(host));
  host.app = app;
  host.display = EGL_NO_DISPLAY;
  host.surface = EGL_NO_SURFACE;
  host.context = EGL_NO_CONTEXT;
  copy_text(host.state, sizeof(host.state), "starting");
  app->userData = &host;
  app->onAppCmd = on_command;
  app->onInputEvent = on_input;
  ANativeActivity_setWindowFlags(
    app->activity,
    AWINDOW_FLAG_FULLSCREEN | AWINDOW_FLAG_KEEP_SCREEN_ON,
    AWINDOW_FLAG_FORCE_NOT_FULLSCREEN
  );
  write_status(&host);
  while (!app->destroyRequested) {
    int events;
    struct android_poll_source *source;
    int identifier;
    int timeout = host.gl_ready && host.focused && !host.failed ? 0 : -1;
    while ((identifier = ALooper_pollAll(timeout, NULL, &events, (void **)&source)) >= 0) {
      if (source != NULL) source->process(app, source);
      if (app->destroyRequested) break;
      timeout = 0;
    }
    if (app->destroyRequested) break;
    if (host.gl_ready && host.focused && !host.failed) render_frame(&host);
  }
  destroy_egl(&host);
  if (host.runtime_ready) pocket_runtime_shutdown();
  free(host.java_script);
  free(host.pack);
  copy_text(host.state, sizeof(host.state), "terminated");
  write_status(&host);
}
