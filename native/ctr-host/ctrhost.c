// twincable's Nintendo 3DS host: runs Azahar's libretro core (azahar_libretro) with Vulkan (MoltenVK on macOS) and
// talks to twincable over stdin/stdout – the 3DS game then plays inside twincable's own player like every other system.
//
//   ctrhost --core <azahar_libretro> --vulkan <libMoltenVK / vulkan loader> --rom <game> --system <dir> --save <dir>
//           [--scale N] [--renderer vulkan|compat|software] [--bench FRAMES --dump out.ppm]
//
// Messages are { u32 type, u32 length, payload } (little-endian), both ways.
//   host → twincable   1 HELLO  json { width, height, fps, sampleRate }      sent once the game runs
//                    2 VIDEO  u16 width, u16 height, u32 format (0 BGRA, 1 RGBA), pixels
//                    3 AUDIO  s16 stereo samples – fast-forward: the sound sped up by the real speed (at most 16×),
//                             resampled to exactly real time (see ff_frame) – twincable's turbo mixer
//                             (web/lib/turboaudio.mjs) plays it per Settings › "Turbo audio"
//                    4 MEM    u32 count, count × { u32 addr, u32 len, bytes }  the watched regions, between frames
//                    5 STATE  a save state (answer to SAVE)
//                    6 LOG    text
//                    7 EVENT  json  { event: 'gpu' | 'loaded' | 'error' | 'stateLoaded' | 'stats' | 'title' | 'written', … }
//                                   stats (four times a second): fps, speed (real, 1 = normal), frame (emulated frames
//                                   so far – the page measures fast-forward with it, not with the pictures it gets)
//                                   ffrate { k }: fast-forward – the sound that follows is sped up k times (sent
//                                   whenever k changes, right before the first sound made with it)
//                                   gpu: the Vulkan device chosen (name, type, vendor, driver …) – sent before the core
//                                   touches it, so a crash in the driver still says which one it was
//                    8 FFSOUND s16 stereo samples – fast-forward only, next to AUDIO: the core's own sound as it comes
//                             (the game's pace: its normal pitch and full bandwidth, k seconds of it per second) – the
//                             turbo mixer's "Music continues" records it instead of slowing AUDIO back down (see ff_frame)
//                    9 ROMFS  u64 frame, u32 count, u32 flags (1: that frame was fast-forwarded), count × { u64 serial,
//                             u64 offset, u32 length, u32 tag, u64 frame } – the
//                             game's RomFS reads (native/azahar-patch/twincable-romfs.patch), sent ten times a second right
//                             before that frame's AUDIO, with the emulated frame each read was seen in (an empty one twice a
//                             second keeps the page's clock): twincable's "music from the ROM" (web/lib/rommusic.mjs) sees
//                             which music stream the game reads and how far
//                   10 ROMDATA u32 id, u32 status (0 ok, 1 the core can't, 2 no such RomFS), u64 size of that RomFS, bytes –
//                             the answer to ROMREAD
//                   11 SFX    u32 flags (2: music voices were left out, 4: somewhere in it the core kept the music in –
//                             not to be played), u32 count, count × u32 (where in the samples a new sound began: key-on
//                             of a voice that isn't music), s16 stereo samples – fast-forward only, in place of FFSOUND,
//                             while twincable asks for it (SFX): the core's own sound without the voices that play the
//                             game's streamed music (native/azahar-patch/twincable-sfx.patch) – the sound effects, which
//                             twincable's turbo mixer plays at 1× over the music track from the ROM (web/lib/sfxplayer.mjs)
//   twincable → host   1 INPUT  u32 joypad bits (RETRO_DEVICE_ID_JOYPAD_*), s16 lx, ly, rx, ry, s16 px, py (pointer,
//                             -0x7fff…0x7fff over the whole picture), u8 pressed
//                    2 SPEED  f32 (1 = normal, 0 = paused, ≥ 100 = as fast as possible)
//                    3 SAVE   –           4 LOAD  state bytes      5 WATCH  u32 count, count × { u32 addr, u32 len }
//                    6 QUIT   –           7 RESET –                8 FRAMESKIP u32 (ignored since 2.7.2: in turbo a
//                             picture goes out about 60 times a second, whatever the speed)
//                    9 WRITE  u32 id, u32 addr, u32 len (≤ 256, inside one 4 KB page of the game's heaps), the bytes
//                             expected there now, the new bytes – a cheat; answered by the event { event: 'written',
//                             id, ok, why } (see mem_write)
//                   10 ROMREAD u32 id, u32 tag, u64 offset, u32 length (≤ 1 MB) – bytes of the RomFS `tag` (from a ROMFS
//                             read) as the game sees it, its update's or a LayeredFS mod's included; answered by ROMDATA
//                             between frames, at most ROMREAD_BUDGET bytes per frame
//                   11 MUSIC  u32 tag, u32 count, count × { u64 start, u64 end } – where the music streams of RomFS `tag`
//                             are (offsets in its level 3; count 0 forgets them): the core recognises the voices that
//                             play them (twincable_audio_music_ranges)
//                   12 SFX    u32 on – leave the music voices out of the fast-forward sound (message 11); the host does
//                             it only while it fast-forwards, the 1× sound is never touched
// Memory reads go through twincable_read_memory (native/azahar-patch: the game process's virtual memory, page by page)
// between two frames – never torn. Azahar's own core (no patch) runs the game without live data.
// Builds on macOS, Linux and Windows (compat.h); scripts/build-ctr.mjs builds it.
//
// --renderer picks how the core draws (twincable's setting "3DS renderer", server/lib/ctrrenderer.mjs):
//   vulkan    (default) Vulkan with the device the standalone Azahar creates: the optional extensions the renderer
//             uses are enabled together with their features (plan_device), robustBufferAccess too
//   compat    Vulkan with only what the core's own libretro device enables – the optional extensions are hidden from
//             it, so the renderer takes its plain fallbacks (2.7.0's behaviour)
//   software  Azahar's software renderer: no GPU at all (slow, but runs on any graphics driver)
// Both Vulkan modes pass the core's vkCreateImage through wrap_create_image (see there – AMD's driver).
//
// Environment (diagnostics): CTRHOST_GPU=<n> uses the n-th Vulkan device (default: the best one – a discrete card
// before an integrated one, never a CPU renderer); CTRHOST_ALL_EXTENSIONS=1 offers the core every device extension
// (see core_gipa); CTRHOST_RENDERER=<mode> as --renderer; CTRHOST_OLD3DS=1 runs the game in Old 3DS mode;
// CTRHOST_DEBUG=1 logs input queries.
#if !defined(_WIN32) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE // dladdr / Dl_info (glibc) – before any system header
#endif
#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>
#include "libretro.h"
#include "libretro_vulkan.h"

#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "compat.h" // dlopen, mutexes, the reader thread, stdin/stdout, time (POSIX or Windows)

#define EXP RETRO_ENVIRONMENT_EXPERIMENTAL
#define IS(cmd, k) (((cmd) & ~EXP) == ((k) & ~EXP))

static void die(const char *fmt, ...);
static void logf_(const char *fmt, ...);

// What the host is doing right now and which graphics card it uses – for the crash report (a crash in the graphics
// driver or the core otherwise only shows as an exit code).
static const char *volatile stage = "starting";
static char gpu_desc[400] = "not chosen yet";
static volatile int images_in_flight; // the core is inside vkCreateImage (wrap_create_image) – and which image
static char image_note[200];

// ---- options ---------------------------------------------------------------------------------------------------
static const char *opt_core, *opt_vulkan, *opt_rom, *opt_system, *opt_save, *opt_dump, *opt_renderer;
static int opt_bench = 0, opt_scale = 1;
static char scale_str[8] = "1";
enum { R_VULKAN, R_COMPAT, R_SOFTWARE };
static int renderer = R_VULKAN;
static const char *const RENDERER_NAMES[] = {"vulkan", "compat", "software"};

// core options twincable sets (everything else: the core's own default)
static const char *core_option(const char *key) {
  if (!strcmp(key, "citra_graphics_api")) return renderer == R_SOFTWARE ? "Software" : "Vulkan";
  if (!strcmp(key, "citra_resolution_factor")) return scale_str;
  if (!strcmp(key, "citra_layout_option")) return "default"; // top above bottom
  if (!strcmp(key, "citra_use_libretro_save_path")) return "LibRetro Default";
  if (!strcmp(key, "citra_analog_function")) return "c_stick";
  if (!strcmp(key, "citra_enable_mouse_touchscreen")) return "disabled";
  if (!strcmp(key, "citra_enable_touch_touchscreen")) return "enabled";
  if (!strcmp(key, "citra_enable_touch_pointer_timeout")) return "enabled"; // the touch cursor fades after a few seconds
  if (!strcmp(key, "citra_use_disk_shader_cache")) return "enabled";
  if (!strcmp(key, "citra_is_new_3ds")) return getenv("CTRHOST_OLD3DS") ? "Old 3DS" : "New 3DS"; // as Azahar itself (the addresses the trackers know)
  return NULL;
}

// ---- protocol out ----------------------------------------------------------------------------------------------
static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;
static int protocol = 1; // off in bench mode

static void write_all(const void *p, size_t n) {
  const uint8_t *b = p;
  while (n) {
    compat_ssize w = compat_write(1, b, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      _exit(0); // twincable went away (_exit: see die() – and this may run on one of the core's threads)
    }
    b += w;
    n -= (size_t)w;
  }
}

static void send_msg2(uint32_t type, const void *a, uint32_t na, const void *b, uint32_t nb) {
  if (!protocol) return;
  uint32_t h[2] = {type, na + nb};
  pthread_mutex_lock(&out_lock);
  write_all(h, 8);
  if (na) write_all(a, na);
  if (nb) write_all(b, nb);
  pthread_mutex_unlock(&out_lock);
}
static void send_msg(uint32_t type, const void *p, uint32_t n) { send_msg2(type, p, n, NULL, 0); }

static void send_event(const char *fmt, ...) {
  char buf[2560];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n > 0) send_msg(7, buf, (uint32_t)(n < (int)sizeof buf ? n : (int)sizeof buf - 1));
}

static void logf_(const char *fmt, ...) {
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n <= 0) return;
  if (n >= (int)sizeof buf) n = sizeof buf - 1;
  fprintf(stderr, "%s%s", buf, buf[n - 1] == '\n' ? "" : "\n");
  if (protocol) send_msg(6, buf, (uint32_t)n);
}

/** `s` as the inside of a JSON string (paths and dlerror() texts bring backslashes – Windows – and quotes along). */
static void json_escape(char *out, size_t cap, const char *s) {
  size_t o = 0;
  for (; *s && o + 7 < cap; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') out[o++] = '\\', out[o++] = (char)c;
    else if (c < 0x20) o += (size_t)snprintf(out + o, cap - o, "\\u%04x", c);
    else out[o++] = (char)c;
  }
  out[o] = 0;
}

static void die(const char *fmt, ...) {
  char buf[1024], esc[900];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  fprintf(stderr, "ctrhost: %s\n", buf);
  json_escape(esc, sizeof esc, buf);
  send_event("{\"event\":\"error\",\"message\":\"%s\"}", esc);
  // _exit, not exit: the exit handlers of what is loaded by then (the Vulkan driver, the core) may hang or crash
  fflush(stderr);
  fflush(stdout);
  _exit(1);
}

/** A crash (signal / Windows exception, compat.h): one line to stderr and – if the pipe is free – an error event. */
static void on_crash(const char *what) {
  char buf[2048], esc[2000];
  int n = snprintf(buf, sizeof buf, "crashed: %s while %s (GPU: %s, renderer %s)%s%s", what, (const char *)stage, gpu_desc, RENDERER_NAMES[renderer],
                   images_in_flight > 0 ? " – inside " : "", images_in_flight > 0 ? image_note : "");
  if (n <= 0) return;
  if (n >= (int)sizeof buf) n = sizeof buf - 1;
  fprintf(stderr, "ctrhost: %s\n", buf);
  fflush(stderr);
  if (protocol && compat_trylock(&out_lock)) { // (never wait: the crashing thread may hold it)
    pthread_mutex_unlock(&out_lock);
    json_escape(esc, sizeof esc, buf);
    send_event("{\"event\":\"error\",\"crash\":true,\"message\":\"%s\"}", esc);
  }
}

// ---- the core --------------------------------------------------------------------------------------------------
static struct {
  void (*init)(void);
  void (*deinit)(void);
  void (*set_environment)(retro_environment_t);
  void (*set_video_refresh)(retro_video_refresh_t);
  void (*set_audio_sample)(retro_audio_sample_t);
  void (*set_audio_sample_batch)(retro_audio_sample_batch_t);
  void (*set_input_poll)(retro_input_poll_t);
  void (*set_input_state)(retro_input_state_t);
  void (*get_system_av_info)(struct retro_system_av_info *);
  bool (*load_game)(const struct retro_game_info *);
  void (*unload_game)(void);
  void (*run)(void);
  void (*reset)(void);
  size_t (*serialize_size)(void);
  bool (*serialize)(void *, size_t);
  bool (*unserialize)(const void *, size_t);
} core;

static struct retro_hw_render_callback hw;
static const struct retro_hw_render_context_negotiation_interface_vulkan *negotiation;
static struct retro_memory_descriptor *memmap;
static unsigned memmap_n;
static int frame_w = 400, frame_h = 480;

// ---- input state (written by the reader thread, read by the core) ----------------------------------------------
static pthread_mutex_t in_lock = PTHREAD_MUTEX_INITIALIZER;
static struct {
  uint32_t buttons;
  int16_t lx, ly, rx, ry, px, py;
  uint8_t pressed;
} input;

static int debug_input; // CTRHOST_DEBUG=1: log what the core asks for (first ones)
// A click is often shorter than games look at the touch screen (the 3DS keyboard wants the stylus down for a few
// frames): every touch counts for at least this many frames, at the position it started.
#define TOUCH_MIN_FRAMES 8
static int touch_latch;
static void input_poll(void) {}
static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  if (debug_input > 0 && device != RETRO_DEVICE_JOYPAD) {
    debug_input--;
    fprintf(stderr, "input_state port=%u device=%u index=%u id=%u pressed=%u px=%d py=%d\n", port, device, index, id, input.pressed, input.px, input.py);
  }
  if (port) return 0;
  int16_t v = 0;
  pthread_mutex_lock(&in_lock);
  switch (device) {
  case RETRO_DEVICE_JOYPAD:
    v = id == RETRO_DEVICE_ID_JOYPAD_MASK ? (int16_t)(input.buttons & 0xffff) : (int16_t)((input.buttons >> id) & 1);
    break;
  case RETRO_DEVICE_ANALOG:
    if (index == RETRO_DEVICE_INDEX_ANALOG_LEFT) v = id == RETRO_DEVICE_ID_ANALOG_X ? input.lx : input.ly;
    else if (index == RETRO_DEVICE_INDEX_ANALOG_RIGHT) v = id == RETRO_DEVICE_ID_ANALOG_X ? input.rx : input.ry;
    break;
  case RETRO_DEVICE_POINTER:
    if (index == 0) {
      if (id == RETRO_DEVICE_ID_POINTER_X) v = input.px;
      else if (id == RETRO_DEVICE_ID_POINTER_Y) v = input.py;
      else if (id == RETRO_DEVICE_ID_POINTER_PRESSED) v = input.pressed || touch_latch > 0;
      else if (id == RETRO_DEVICE_ID_POINTER_COUNT) v = input.pressed || touch_latch > 0 ? 1 : 0;
    }
    break;
  }
  pthread_mutex_unlock(&in_lock);
  return v;
}

// ---- audio: collected per frame, sent after it ------------------------------------------------------------------
static int16_t *audio_buf;
static size_t audio_n, audio_cap;

#include "ffsound.h" // fast-forward sound: the queue, the ratio and the resampler (shared with retrohost.c)

static void audio_push(const int16_t *d, size_t frames) {
  if (!frames) return;
  if (audio_n + frames * 2 > audio_cap) {
    size_t cap = (audio_n + frames * 2) * 2;
    int16_t *b = realloc(audio_buf, cap * sizeof *b);
    if (!b) return; // out of memory: this frame's sound is left out
    audio_buf = b;
    audio_cap = cap;
  }
  memcpy(audio_buf + audio_n, d, frames * 2 * sizeof *d);
  audio_n += frames * 2;
}
static void audio_sample(int16_t l, int16_t r) {
  int16_t s[2] = {l, r};
  audio_push(s, 1);
}
// twincable's sound effects during fast-forward (native/azahar-patch/twincable-sfx.patch): while the page asks for them and
// the game fast-forwards, the core leaves the voices that play the game's streamed music out of its sound (the page plays
// the music itself, from the ROM) and says per DSP frame (160 samples) what that frame is – asked from right here, the
// core hands each frame to this callback as it makes it. sfx_onsets: where in audio_buf a new sound (not music) began.
static void (*twincable_audio_music_ranges)(uint32_t tag, const uint64_t *pairs, uint32_t n);
static void (*twincable_audio_mute_music)(uint32_t on);
static uint32_t (*twincable_audio_frame_flags)(void);
static uint32_t (*twincable_audio_music_state)(uint64_t *out, uint32_t max);
#define SFX_ONSET 1u
#define SFX_MUTED 2u
#define SFX_UNSURE 4u
#define SFX_MUSIC 16u
#define MAX_ONSETS 256
static int sfx_muting; // the core leaves the music out now (asked for this frame)
static uint32_t sfx_flags, sfx_onsets[MAX_ONSETS], sfx_n;
static size_t audio_batch(const int16_t *d, size_t frames) {
  if (sfx_muting && twincable_audio_frame_flags) {
    const uint32_t f = twincable_audio_frame_flags();
    if ((f & SFX_ONSET) && sfx_n < MAX_ONSETS) sfx_onsets[sfx_n++] = (uint32_t)(audio_n / 2);
    // a frame that kept music in it (asked but unsure, or a music voice not left out) spoils the whole message: the page
    // must not play it as sound effects
    sfx_flags |= f & SFX_UNSURE;
    if ((f & SFX_MUSIC) && !(f & SFX_MUTED)) sfx_flags |= SFX_UNSURE;
    sfx_flags |= f & SFX_MUTED;
  }
  audio_push(d, frames);
  return frames;
}

// ---- Vulkan ------------------------------------------------------------------------------------------------------
static PFN_vkGetInstanceProcAddr gipa;
static PFN_vkGetDeviceProcAddr gdpa;
static VkInstance instance;
static VkPhysicalDevice gpu;
static struct retro_vulkan_context vkctx;
static struct retro_hw_render_interface_vulkan vkif;
static pthread_mutex_t queue_lock = PTHREAD_MUTEX_INITIALIZER;
static const struct retro_vulkan_image *cur_image;
static const VkCommandBuffer *pending_cmds;
static unsigned pending_n;

#define DEV_FN(name) static PFN_##name name##_
DEV_FN(vkCreateCommandPool); DEV_FN(vkAllocateCommandBuffers); DEV_FN(vkBeginCommandBuffer); DEV_FN(vkEndCommandBuffer);
DEV_FN(vkCmdPipelineBarrier); DEV_FN(vkCmdCopyImageToBuffer); DEV_FN(vkQueueSubmit); DEV_FN(vkCreateFence);
DEV_FN(vkWaitForFences); DEV_FN(vkResetFences); DEV_FN(vkCreateBuffer); DEV_FN(vkGetBufferMemoryRequirements);
DEV_FN(vkAllocateMemory); DEV_FN(vkBindBufferMemory); DEV_FN(vkMapMemory); DEV_FN(vkDestroyBuffer); DEV_FN(vkFreeMemory);
DEV_FN(vkResetCommandBuffer); DEV_FN(vkQueueWaitIdle);
static PFN_vkGetPhysicalDeviceMemoryProperties vkGetPhysicalDeviceMemoryProperties_;
static PFN_vkEnumerateDeviceExtensionProperties real_enum_dev_ext;

static VkCommandPool cmd_pool;
static VkCommandBuffer cmd;
static VkFence fence;
static VkBuffer rb_buf;
static VkDeviceMemory rb_mem;
static void *rb_ptr;
static VkDeviceSize rb_size;

static uint32_t vk_sync_index(void *h) { (void)h; return 0; }
static uint32_t vk_sync_mask(void *h) { (void)h; return 1; }
static void vk_wait_sync(void *h) { (void)h; }
static void vk_lock(void *h) { (void)h; pthread_mutex_lock(&queue_lock); }
static void vk_unlock(void *h) { (void)h; pthread_mutex_unlock(&queue_lock); }
static void vk_set_image(void *h, const struct retro_vulkan_image *image, uint32_t n, const VkSemaphore *sems, uint32_t qf) {
  (void)h; (void)n; (void)sems; (void)qf;
  cur_image = image;
}
static void vk_set_cmds(void *h, uint32_t n, const VkCommandBuffer *cmds) {
  (void)h;
  pending_cmds = cmds;
  pending_n = n;
}
static void vk_set_signal(void *h, VkSemaphore s) { (void)h; (void)s; }

static void *load_vk(const char *path) {
  void *lib = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!lib) die("Vulkan library not loadable: %s", dlerror());
  gipa = (PFN_vkGetInstanceProcAddr)dlsym(lib, "vkGetInstanceProcAddr");
  if (!gipa) die("vkGetInstanceProcAddr missing in %s", path);
  char where[1024];
  compat_lib_path((const void *)gipa, where, sizeof where);
  logf_("Vulkan loader: %s (asked for %s)", *where ? where : "?", path);
  PFN_vkEnumerateInstanceVersion ver = (PFN_vkEnumerateInstanceVersion)gipa(NULL, "vkEnumerateInstanceVersion");
  uint32_t v = VK_API_VERSION_1_0;
  if (ver) ver(&v);
  logf_("Vulkan loader version %u.%u.%u", v >> 22, (v >> 12) & 0x3ff, v & 0xfff);
  return lib;
}

// ---- the core's Vulkan device ------------------------------------------------------------------------------------
// The core creates its Vulkan device itself (negotiation->create_device – Azahar's CreateVulkanDevice in
// citra_libretro/libretro_vk.cpp) and enables only a fixed few extensions and features there – but its renderer then
// decides which optional features to use from the extensions the GPU *offers* (Azahar 2126.2, vk_instance.cpp
// CreateDevice: timeline semaphores, extended dynamic state, 8-bit indices, shader interlock / barycentrics, pipeline
// cache control). Used on a device that never enabled them, that is undefined behaviour. The standalone Azahar creates
// its device with each of them enabled together with its feature struct, and with robustBufferAccess (both at Vulkan
// 1.1 – vk_platform.h TargetVulkanApiVersion; the core asks for 1.1 as well).
// The core looks vkCreateDevice up through the vkGetInstanceProcAddr it is handed (core_gipa), so ctrhost adds what
// the standalone app enables (wrap_create_device, from plan_device) – mode "vulkan": the device the core renders on is
// the one Azahar's main path is made and tested for. Mode "compat" (2.7.0's way) leaves the core's device as it is and
// hides those extensions instead (filtered_enum_dev_ext): the renderer takes its fallbacks (fences, static state,
// 16-bit indices, plain shaders).
static const char *const HIDDEN_EXTS[] = {
  "VK_KHR_timeline_semaphore", "VK_EXT_extended_dynamic_state", "VK_EXT_index_type_uint8", "VK_EXT_fragment_shader_interlock",
  "VK_EXT_pipeline_creation_cache_control", "VK_KHR_fragment_shader_barycentric", NULL,
};
static int all_exts; // CTRHOST_ALL_EXTENSIONS=1: no filtering (to compare)
static uint32_t driver_id; // VkDriverId of the chosen card (0: unknown)

// What wrap_create_device adds to the core's device (mode "vulkan"): extensions, their feature structs, robustBufferAccess.
static struct {
  const char *ext[8];
  unsigned n;
  int robust;
  void *chain[8]; // the feature structs below that go into the device's pNext chain
  unsigned nchain;
  VkPhysicalDeviceTimelineSemaphoreFeatures timeline;
  VkPhysicalDeviceExtendedDynamicStateFeaturesEXT eds;
  VkPhysicalDeviceIndexTypeUint8FeaturesEXT uint8;
  VkPhysicalDeviceFragmentShaderInterlockFeaturesEXT interlock;
  VkPhysicalDevicePipelineCreationCacheControlFeaturesEXT cache_control;
  VkPhysicalDeviceFragmentShaderBarycentricFeaturesKHR barycentric;
} plan;
static int planned(const char *name) {
  for (unsigned i = 0; i < plan.n; i++)
    if (!strcmp(plan.ext[i], name)) return 1;
  return 0;
}
static int hidden_ext(const char *name) {
  if (all_exts) return 0;
  for (int i = 0; HIDDEN_EXTS[i]; i++)
    if (!strcmp(name, HIDDEN_EXTS[i])) return !(renderer == R_VULKAN && planned(name));
  return 0;
}
static int has_ext(const VkExtensionProperties *exts, uint32_t n, const char *name) {
  for (uint32_t i = 0; i < n; i++)
    if (!strcmp(exts[i].extensionName, name)) return 1;
  return 0;
}

/**
 * Which optional extensions the standalone Azahar would enable on this card (the same rules as its vk_instance.cpp:
 * offered, its feature supported, not on a driver Azahar blocks it for) – they and robustBufferAccess are added to the
 * core's device in mode "vulkan".
 */
static void plan_device(VkPhysicalDevice pd, const VkExtensionProperties *exts, uint32_t ne) {
  memset(&plan, 0, sizeof plan);
  if (renderer != R_VULKAN) return;
  PFN_vkGetPhysicalDeviceFeatures2 features2 = (PFN_vkGetPhysicalDeviceFeatures2)gipa(instance, "vkGetPhysicalDeviceFeatures2");
  if (!features2) features2 = (PFN_vkGetPhysicalDeviceFeatures2)gipa(instance, "vkGetPhysicalDeviceFeatures2KHR");
  PFN_vkGetPhysicalDeviceFeatures features1 = (PFN_vkGetPhysicalDeviceFeatures)gipa(instance, "vkGetPhysicalDeviceFeatures");
  const int nvidia = driver_id == VK_DRIVER_ID_NVIDIA_PROPRIETARY, moltenvk = driver_id == VK_DRIVER_ID_MOLTENVK;
  const int qualcomm = driver_id == VK_DRIVER_ID_QUALCOMM_PROPRIETARY, turnip = driver_id == VK_DRIVER_ID_MESA_TURNIP;
  const int arm = driver_id == VK_DRIVER_ID_ARM_PROPRIETARY;
  struct cand { const char *name; int blocked; VkBaseOutStructure *feat; size_t size; VkStructureType type; VkBool32 *bit; } c[] = {
    {VK_KHR_TIMELINE_SEMAPHORE_EXTENSION_NAME, qualcomm || turnip, (VkBaseOutStructure *)&plan.timeline, sizeof plan.timeline,
     VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TIMELINE_SEMAPHORE_FEATURES, &plan.timeline.timelineSemaphore},
    {VK_EXT_EXTENDED_DYNAMIC_STATE_EXTENSION_NAME, arm || qualcomm, (VkBaseOutStructure *)&plan.eds, sizeof plan.eds,
     VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTENDED_DYNAMIC_STATE_FEATURES_EXT, &plan.eds.extendedDynamicState},
    {VK_EXT_INDEX_TYPE_UINT8_EXTENSION_NAME, moltenvk, (VkBaseOutStructure *)&plan.uint8, sizeof plan.uint8,
     VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_INDEX_TYPE_UINT8_FEATURES_EXT, &plan.uint8.indexTypeUint8},
    {VK_EXT_FRAGMENT_SHADER_INTERLOCK_EXTENSION_NAME, nvidia, (VkBaseOutStructure *)&plan.interlock, sizeof plan.interlock,
     VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_SHADER_INTERLOCK_FEATURES_EXT, &plan.interlock.fragmentShaderPixelInterlock},
    {VK_EXT_PIPELINE_CREATION_CACHE_CONTROL_EXTENSION_NAME, nvidia, (VkBaseOutStructure *)&plan.cache_control, sizeof plan.cache_control,
     VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PIPELINE_CREATION_CACHE_CONTROL_FEATURES_EXT, &plan.cache_control.pipelineCreationCacheControl},
    {VK_KHR_FRAGMENT_SHADER_BARYCENTRIC_EXTENSION_NAME, moltenvk, (VkBaseOutStructure *)&plan.barycentric, sizeof plan.barycentric,
     VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_SHADER_BARYCENTRIC_FEATURES_KHR, &plan.barycentric.fragmentShaderBarycentric},
  };
  const unsigned nc = sizeof c / sizeof *c;
  // ask the card which of the features it supports (only the structs of extensions it offers go into the query)
  VkPhysicalDeviceFeatures2 q;
  memset(&q, 0, sizeof q);
  q.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
  int avail[8] = {0};
  for (unsigned i = 0; i < nc; i++) {
    c[i].feat->sType = c[i].type;
    avail[i] = has_ext(exts, ne, c[i].name);
    if (avail[i] && features2) {
      c[i].feat->pNext = q.pNext;
      q.pNext = c[i].feat;
    }
  }
  if (features2) features2(pd, &q);
  else if (features1) features1(pd, &q.features);
  plan.robust = !!q.features.robustBufferAccess;
  for (unsigned i = 0; i < nc; i++) {
    const int on = features2 && avail[i] && !c[i].blocked && *c[i].bit;
    // the struct as it goes into the device: only the one feature Azahar uses, the rest off
    void *keep = c[i].feat;
    memset(keep, 0, c[i].size);
    c[i].feat->sType = c[i].type;
    if (!on) continue;
    *c[i].bit = VK_TRUE;
    plan.ext[plan.n++] = c[i].name;
    plan.chain[plan.nchain++] = keep;
  }
}

/** Is a struct of this type in a pNext chain? */
static int chain_has(const void *p, VkStructureType type) {
  for (const VkBaseInStructure *b = p; b; b = b->pNext)
    if (b->sType == type) return 1;
  return 0;
}

static PFN_vkCreateDevice real_create_device;
/** vkCreateDevice as the core sees it: in mode "vulkan" with plan_device's extensions, features and robustBufferAccess. */
static VKAPI_ATTR VkResult VKAPI_CALL wrap_create_device(VkPhysicalDevice pd, const VkDeviceCreateInfo *ci, const VkAllocationCallbacks *alloc, VkDevice *dev) {
  if (!real_create_device) real_create_device = (PFN_vkCreateDevice)gipa(instance, "vkCreateDevice");
  if (!real_create_device) return VK_ERROR_INITIALIZATION_FAILED;
  if (!ci || renderer != R_VULKAN || (!plan.n && !plan.robust)) return real_create_device(pd, ci, alloc, dev);
  VkDeviceCreateInfo c = *ci;
  const char *exts[72];
  uint32_t n = 0;
  for (uint32_t i = 0; i < ci->enabledExtensionCount && n < 64; i++) exts[n++] = ci->ppEnabledExtensionNames[i];
  char added[600] = "";
  size_t al = 0;
  for (unsigned k = 0; k < plan.n; k++) {
    int dup = 0;
    for (uint32_t i = 0; i < n; i++) dup |= !strcmp(exts[i], plan.ext[k]);
    if (dup) continue;
    exts[n++] = plan.ext[k];
    al += (size_t)snprintf(added + al, sizeof added - al, " %s", plan.ext[k]);
  }
  c.enabledExtensionCount = n;
  c.ppEnabledExtensionNames = exts;
  // robustBufferAccess: in the core's VkPhysicalDeviceFeatures2 (Azahar chains one first) or in pEnabledFeatures
  VkPhysicalDeviceFeatures2 f2;
  VkPhysicalDeviceFeatures f1;
  void *head = (void *)ci->pNext;
  const VkBaseInStructure *first = ci->pNext;
  int robust = 0;
  if (plan.robust) {
    if (first && first->sType == VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2) {
      f2 = *(const VkPhysicalDeviceFeatures2 *)first; // (its pNext: the rest of the core's chain)
      f2.features.robustBufferAccess = VK_TRUE;
      head = &f2;
      robust = 1;
    } else if (ci->pEnabledFeatures) {
      f1 = *ci->pEnabledFeatures;
      f1.robustBufferAccess = VK_TRUE;
      c.pEnabledFeatures = &f1;
      robust = 1;
    } else if (!chain_has(ci->pNext, VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2)) {
      memset(&f1, 0, sizeof f1);
      f1.robustBufferAccess = VK_TRUE;
      c.pEnabledFeatures = &f1;
      robust = 1;
    }
  }
  for (unsigned k = 0; k < plan.nchain; k++) {
    VkBaseOutStructure *b = plan.chain[k];
    if (chain_has(ci->pNext, b->sType)) continue; // (the core chained that one itself)
    b->pNext = head;
    head = b;
  }
  c.pNext = head;
  VkResult r = real_create_device(pd, &c, alloc, dev);
  if (r == VK_SUCCESS) {
    logf_("Vulkan: the core's device has what the standalone Azahar enables:%s%s", robust ? " robustBufferAccess" : "", *added ? added : " (no optional extensions)");
    return r;
  }
  // a driver that refuses the combination: the core's own device, and the extensions hidden again (as "compat")
  logf_("Vulkan: vkCreateDevice with the standalone features failed (%d) – the core's own device instead", (int)r);
  plan.n = plan.nchain = 0;
  plan.robust = 0;
  return real_create_device(pd, ci, alloc, dev);
}

// AMD's Windows driver (amdvlk64.dll, seen on the RX 9070 XT with driver 2.0.416) crashes inside vkCreateImage with
// Azahar's libretro core since 2126.1 (azahar-emu/azahar#2742 – the same access violation the player hit; standalone
// Azahar is fine). The workaround found there (#2745): hand the driver a copy of the VkImageCreateInfo whose queue
// family fields are cleared for an exclusive image – the spec says they are ignored then, the driver reads them anyway.
// ctrhost does that for every image the core creates (VMA's and its own – both look vkCreateImage up through
// core_gipa / core_gdpa), logs it when the fields really were set, and remembers the image in flight for a crash report.
static PFN_vkCreateImage real_create_image;
static volatile unsigned images_fixed, images_created;
static VKAPI_ATTR VkResult VKAPI_CALL wrap_create_image(VkDevice d, const VkImageCreateInfo *ci, const VkAllocationCallbacks *alloc, VkImage *img) {
  PFN_vkCreateImage real = real_create_image;
  if (!real) real = real_create_image = (PFN_vkCreateImage)gdpa(d, "vkCreateImage");
  if (!real) return VK_ERROR_INITIALIZATION_FAILED;
  if (!ci) return real(d, ci, alloc, img);
  VkImageCreateInfo c = *ci;
  if (c.sharingMode == VK_SHARING_MODE_EXCLUSIVE && (c.queueFamilyIndexCount || c.pQueueFamilyIndices)) {
    if (__atomic_fetch_add(&images_fixed, 1, __ATOMIC_RELAXED) < 3)
      logf_("vkCreateImage: queue family fields set on an exclusive image (count %u, %p) – cleared", c.queueFamilyIndexCount, (const void *)c.pQueueFamilyIndices);
    c.queueFamilyIndexCount = 0;
    c.pQueueFamilyIndices = NULL;
  }
  snprintf(image_note, sizeof image_note, "vkCreateImage format %d %ux%ux%u, %u levels, %u layers, usage 0x%x, flags 0x%x%s", (int)c.format,
           c.extent.width, c.extent.height, c.extent.depth, c.mipLevels, c.arrayLayers, (unsigned)c.usage, (unsigned)c.flags, c.pNext ? ", pNext" : "");
  __atomic_fetch_add(&images_created, 1, __ATOMIC_RELAXED);
  __atomic_fetch_add(&images_in_flight, 1, __ATOMIC_SEQ_CST);
  VkResult r = real(d, &c, alloc, img);
  __atomic_fetch_sub(&images_in_flight, 1, __ATOMIC_SEQ_CST);
  return r;
}

/** All of a device's extensions (calloc'd, *n of them), or NULL. */
static VkExtensionProperties *device_exts(VkPhysicalDevice pd, const char *layer, uint32_t *n) {
  *n = 0;
  if (!real_enum_dev_ext) return NULL;
  for (int tries = 0; tries < 4; tries++) {
    uint32_t c = 0;
    if (real_enum_dev_ext(pd, layer, &c, NULL) != VK_SUCCESS) return NULL;
    VkExtensionProperties *all = calloc(c ? c : 1, sizeof *all);
    if (!all) return NULL;
    VkResult r = real_enum_dev_ext(pd, layer, &c, all);
    if (r == VK_SUCCESS) {
      *n = c;
      return all;
    }
    free(all);
    if (r != VK_INCOMPLETE) return NULL;
  }
  return NULL;
}
static VKAPI_ATTR VkResult VKAPI_CALL filtered_enum_dev_ext(VkPhysicalDevice pd, const char *layer, uint32_t *count, VkExtensionProperties *props) {
  uint32_t n = 0, k = 0;
  VkExtensionProperties *all = device_exts(pd, layer, &n);
  if (!all) return real_enum_dev_ext(pd, layer, count, props);
  for (uint32_t i = 0; i < n; i++)
    if (!hidden_ext(all[i].extensionName)) all[k++] = all[i];
  VkResult r = VK_SUCCESS;
  if (props) {
    if (*count < k) k = *count, r = VK_INCOMPLETE;
    memcpy(props, all, k * sizeof *all);
  }
  *count = k;
  free(all);
  return r;
}
/**
 * vkGetDeviceProcAddr as the core sees it: vkCreateImage through wrap_create_image – and itself for
 * "vkGetDeviceProcAddr" (vulkan-hpp's dispatcher looks that one up again through the device before it loads the
 * device's functions; handing out the real one there let every later lookup, VMA's too, bypass the wrapper).
 */
static VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL core_gdpa(VkDevice d, const char *name) {
  if (name && !strcmp(name, "vkGetDeviceProcAddr")) return (PFN_vkVoidFunction)core_gdpa;
  if (name && !strcmp(name, "vkCreateImage")) {
    if (!real_create_image) real_create_image = (PFN_vkCreateImage)gdpa(d, name);
    if (real_create_image) return (PFN_vkVoidFunction)wrap_create_image;
  }
  return gdpa(d, name);
}
/**
 * vkGetInstanceProcAddr as the core sees it: the device-extension list without the hidden ones, vkCreateDevice
 * with the standalone features, vkCreateImage and vkGetDeviceProcAddr through the wrappers above.
 */
static VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL core_gipa(VkInstance inst, const char *name) {
  if (inst && name) {
    if (!strcmp(name, "vkEnumerateDeviceExtensionProperties") && real_enum_dev_ext) return (PFN_vkVoidFunction)filtered_enum_dev_ext;
    if (!strcmp(name, "vkCreateDevice")) return (PFN_vkVoidFunction)wrap_create_device;
    if (!strcmp(name, "vkGetDeviceProcAddr") && gdpa) return (PFN_vkVoidFunction)core_gdpa;
    if (!strcmp(name, "vkCreateImage")) return (PFN_vkVoidFunction)wrap_create_image;
  }
  return gipa(inst, name);
}

static const char *gpu_type_name(VkPhysicalDeviceType t) {
  switch (t) {
  case VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU: return "discrete";
  case VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU: return "integrated";
  case VK_PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU: return "virtual";
  case VK_PHYSICAL_DEVICE_TYPE_CPU: return "cpu";
  default: return "other";
  }
}
/** The driver version as the vendor numbers it (NVIDIA and Intel on Windows have their own schemes). */
static void driver_version(char *out, size_t cap, uint32_t vendor, uint32_t v) {
  if (vendor == 0x10DE) snprintf(out, cap, "%u.%u.%u", (v >> 22) & 0x3ff, (v >> 14) & 0xff, (v >> 6) & 0xff);
#ifdef _WIN32
  else if (vendor == 0x8086) snprintf(out, cap, "%u.%u", v >> 14, v & 0x3fff);
#endif
  else snprintf(out, cap, "%u.%u.%u", v >> 22, (v >> 12) & 0x3ff, v & 0xfff);
}
/** Usable for the core: Vulkan 1.1 and a graphics queue. Higher is better (discrete > integrated > virtual > other). */
static int gpu_score(VkPhysicalDevice d, const VkPhysicalDeviceProperties *p) {
  if ((p->apiVersion >> 22) == 1 && ((p->apiVersion >> 12) & 0x3ff) < 1) return -1;
  PFN_vkGetPhysicalDeviceQueueFamilyProperties qf = (PFN_vkGetPhysicalDeviceQueueFamilyProperties)gipa(instance, "vkGetPhysicalDeviceQueueFamilyProperties");
  uint32_t nq = 0;
  if (qf) qf(d, &nq, NULL);
  VkQueueFamilyProperties q[32];
  if (nq > 32) nq = 32;
  if (qf && nq) qf(d, &nq, q);
  int graphics = 0;
  for (uint32_t i = 0; i < nq; i++) graphics |= !!(q[i].queueFlags & VK_QUEUE_GRAPHICS_BIT);
  if (!graphics) return -1;
  switch (p->deviceType) {
  case VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU: return 4;
  case VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU: return 3;
  case VK_PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU: return 2;
  case VK_PHYSICAL_DEVICE_TYPE_CPU: return 0;
  default: return 1;
  }
}

/** Pick the graphics card, tell twincable which one (event "gpu" + log), before the core gets to it. */
static void choose_gpu(void) {
  PFN_vkEnumeratePhysicalDevices enum_dev = (PFN_vkEnumeratePhysicalDevices)gipa(instance, "vkEnumeratePhysicalDevices");
  PFN_vkGetPhysicalDeviceProperties props_fn = (PFN_vkGetPhysicalDeviceProperties)gipa(instance, "vkGetPhysicalDeviceProperties");
  PFN_vkGetPhysicalDeviceProperties2 props2_fn = (PFN_vkGetPhysicalDeviceProperties2)gipa(instance, "vkGetPhysicalDeviceProperties2");
  if (!props2_fn) props2_fn = (PFN_vkGetPhysicalDeviceProperties2)gipa(instance, "vkGetPhysicalDeviceProperties2KHR");
  uint32_t nd = 0;
  VkResult r = enum_dev ? enum_dev(instance, &nd, NULL) : VK_ERROR_INITIALIZATION_FAILED;
  if (r != VK_SUCCESS || !nd) die("no Vulkan graphics card found (vkEnumeratePhysicalDevices: %d, %u devices) – update the graphics driver", r, nd);
  VkPhysicalDevice devs[16];
  if (nd > 16) nd = 16;
  r = enum_dev(instance, &nd, devs);
  if (r != VK_SUCCESS && r != VK_INCOMPLETE) die("vkEnumeratePhysicalDevices failed (%d)", r);
  const char *force = getenv("CTRHOST_GPU");
  int best = -1, best_score = -1;
  VkPhysicalDeviceProperties p[16];
  for (uint32_t i = 0; i < nd; i++) {
    props_fn(devs[i], &p[i]);
    int sc = gpu_score(devs[i], &p[i]);
    char drv[32];
    driver_version(drv, sizeof drv, p[i].vendorID, p[i].driverVersion);
    logf_("Vulkan device %u: %s (%s, %04x:%04x, driver %s, Vulkan %u.%u.%u)%s", i, p[i].deviceName, gpu_type_name(p[i].deviceType), p[i].vendorID,
          p[i].deviceID, drv, p[i].apiVersion >> 22, (p[i].apiVersion >> 12) & 0x3ff, p[i].apiVersion & 0xfff, sc < 0 ? " – not usable" : "");
    if (sc > best_score) best = (int)i, best_score = sc;
  }
  if (force && *force >= '0' && *force <= '9' && (uint32_t)atoi(force) < nd) best = atoi(force);
  if (best < 0) die("no usable Vulkan graphics card (Vulkan 1.1 with graphics is needed) – update the graphics driver");
  gpu = devs[best];
  const VkPhysicalDeviceProperties *g = &p[best];
  char drv[32], name[300] = "", info[300] = "";
  driver_version(drv, sizeof drv, g->vendorID, g->driverVersion);
  // the driver's own name and version text (VK_KHR_driver_properties), e.g. "AMD proprietary driver" "25.10.2"
  uint32_t ne = 0;
  VkExtensionProperties *exts = device_exts(gpu, NULL, &ne);
  int has_driver_props = ((g->apiVersion >> 22) > 1 || ((g->apiVersion >> 12) & 0x3ff) >= 2);
  for (uint32_t i = 0; i < ne; i++) has_driver_props |= !strcmp(exts[i].extensionName, "VK_KHR_driver_properties");
  if (props2_fn && has_driver_props) {
    VkPhysicalDeviceDriverPropertiesKHR dp;
    memset(&dp, 0, sizeof dp);
    dp.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRIVER_PROPERTIES_KHR;
    VkPhysicalDeviceProperties2 p2;
    memset(&p2, 0, sizeof p2);
    p2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2;
    p2.pNext = &dp;
    props2_fn(gpu, &p2);
    snprintf(name, sizeof name, "%s", dp.driverName);
    snprintf(info, sizeof info, "%s", dp.driverInfo);
    driver_id = (uint32_t)dp.driverID;
  }
  // mode "vulkan": what the core's device gets on top (the standalone Azahar's device); then which extensions the core
  // won't see (not enabled on its device – see HIDDEN_EXTS)
  plan_device(gpu, exts, ne);
  char hidden[400] = "";
  size_t hl = 0;
  for (uint32_t i = 0; i < ne && hl + 64 < sizeof hidden; i++)
    if (hidden_ext(exts[i].extensionName)) hl += (size_t)snprintf(hidden + hl, sizeof hidden - hl, "%s%s", hl ? " " : "", exts[i].extensionName);
  free(exts);
  snprintf(gpu_desc, sizeof gpu_desc, "%s, %s, %04x:%04x, driver %s%s%s%s%s, Vulkan %u.%u.%u", g->deviceName, gpu_type_name(g->deviceType), g->vendorID,
           g->deviceID, drv, *name ? " " : "", name, *info ? " " : "", info, g->apiVersion >> 22, (g->apiVersion >> 12) & 0x3ff, g->apiVersion & 0xfff);
  logf_("Vulkan: using device %d of %u – %s", best, nd, gpu_desc);
  if (renderer == R_VULKAN) {
    char pl[400] = "";
    size_t pn = 0;
    for (unsigned i = 0; i < plan.n && pn + 64 < sizeof pl; i++) pn += (size_t)snprintf(pl + pn, sizeof pl - pn, " %s", plan.ext[i]);
    logf_("Vulkan: renderer mode vulkan – the core's device gets%s%s", plan.robust ? " robustBufferAccess" : "", *pl ? pl : (plan.robust ? "" : " nothing more"));
  } else logf_("Vulkan: renderer mode compat – the core's own libretro device");
  if (*hidden) logf_("Vulkan: left out for the core (its device doesn't enable them): %s", hidden);
  char e_name[600], e_drv[700];
  json_escape(e_name, sizeof e_name, g->deviceName);
  char drv_all[400];
  snprintf(drv_all, sizeof drv_all, "%s%s%s%s%s", drv, *name ? " " : "", name, *info ? " " : "", info);
  json_escape(e_drv, sizeof e_drv, drv_all);
  send_event("{\"event\":\"gpu\",\"name\":\"%s\",\"type\":\"%s\",\"vendor\":\"%04x\",\"device\":\"%04x\",\"driver\":\"%s\",\"api\":\"%u.%u.%u\",\"index\":%d,\"count\":%u,\"filtered\":%s,\"renderer\":\"%s\"}",
             e_name, gpu_type_name(g->deviceType), g->vendorID, g->deviceID, e_drv, g->apiVersion >> 22, (g->apiVersion >> 12) & 0x3ff, g->apiVersion & 0xfff, best, nd,
             all_exts ? "false" : "true", RENDERER_NAMES[renderer]);
}

static void vk_setup(void) {
  const VkApplicationInfo *app = negotiation && negotiation->get_application_info ? negotiation->get_application_info() : NULL;
  VkApplicationInfo def = {VK_STRUCTURE_TYPE_APPLICATION_INFO, NULL, "twincable", 1, "twincable", 1, VK_API_VERSION_1_1};
  PFN_vkEnumerateInstanceExtensionProperties enum_ext = (PFN_vkEnumerateInstanceExtensionProperties)gipa(NULL, "vkEnumerateInstanceExtensionProperties");
  PFN_vkCreateInstance create_instance = (PFN_vkCreateInstance)gipa(NULL, "vkCreateInstance");
  if (!enum_ext || !create_instance) die("the Vulkan loader is incomplete (vkCreateInstance missing) – reinstall the graphics driver");
  uint32_t n = 0;
  enum_ext(NULL, &n, NULL);
  VkExtensionProperties *props = calloc(n ? n : 1, sizeof *props);
  if (props && enum_ext(NULL, &n, props) != VK_SUCCESS) n = 0;
  const char *exts[4];
  uint32_t ne = 0;
  VkInstanceCreateFlags flags = 0;
  for (uint32_t i = 0; props && i < n; i++) {
    if (!strcmp(props[i].extensionName, VK_KHR_GET_PHYSICAL_DEVICE_PROPERTIES_2_EXTENSION_NAME)) exts[ne++] = VK_KHR_GET_PHYSICAL_DEVICE_PROPERTIES_2_EXTENSION_NAME;
    if (!strcmp(props[i].extensionName, VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME)) {
      exts[ne++] = VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME;
      flags |= VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR;
    }
  }
  free(props);
  VkInstanceCreateInfo ici = {VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, NULL, flags, app ? app : &def, 0, NULL, ne, exts};
  {
    const VkApplicationInfo *ai = ici.pApplicationInfo;
    logf_("Vulkan instance: API %u.%u for %s, %u of %u instance extensions:%s%s%s%s", ai->apiVersion >> 22, (ai->apiVersion >> 12) & 0x3ff,
          ai->pApplicationName ? ai->pApplicationName : "?", ne, n, ne > 0 ? " " : "", ne > 0 ? exts[0] : "", ne > 1 ? " " : "", ne > 1 ? exts[1] : "");
  }
  stage = "creating the Vulkan instance";
  VkResult r = create_instance(&ici, NULL, &instance);
  if (r != VK_SUCCESS) die("vkCreateInstance failed (%d) – the graphics driver doesn't offer Vulkan 1.1", r);
  gdpa = (PFN_vkGetDeviceProcAddr)gipa(instance, "vkGetDeviceProcAddr");
  vkGetPhysicalDeviceMemoryProperties_ = (PFN_vkGetPhysicalDeviceMemoryProperties)gipa(instance, "vkGetPhysicalDeviceMemoryProperties");
  real_enum_dev_ext = (PFN_vkEnumerateDeviceExtensionProperties)gipa(instance, "vkEnumerateDeviceExtensionProperties");
  all_exts = !!getenv("CTRHOST_ALL_EXTENSIONS");
  stage = "choosing the graphics card";
  choose_gpu();

  memset(&vkctx, 0, sizeof vkctx);
  if (!negotiation || !negotiation->create_device) die("the core offers no Vulkan device creation");
  stage = "creating the Vulkan device (core)";
  if (!negotiation->create_device(&vkctx, instance, gpu, VK_NULL_HANDLE, core_gipa, NULL, 0, NULL, 0, NULL))
    die("the core couldn't create its Vulkan device (vkCreateDevice – see the [core] lines before) – GPU: %s", gpu_desc);
  if (!vkctx.device || !vkctx.queue) die("the core's Vulkan device has no queue");
  logf_("Vulkan device created: queue family %u", vkctx.queue_family_index);
  stage = "setting up the picture readback";

#define LOADD(name) name##_ = (PFN_##name)gdpa(vkctx.device, #name); if (!name##_) die("missing %s", #name)
  LOADD(vkCreateCommandPool); LOADD(vkAllocateCommandBuffers); LOADD(vkBeginCommandBuffer); LOADD(vkEndCommandBuffer);
  LOADD(vkCmdPipelineBarrier); LOADD(vkCmdCopyImageToBuffer); LOADD(vkQueueSubmit); LOADD(vkCreateFence);
  LOADD(vkWaitForFences); LOADD(vkResetFences); LOADD(vkCreateBuffer); LOADD(vkGetBufferMemoryRequirements);
  LOADD(vkAllocateMemory); LOADD(vkBindBufferMemory); LOADD(vkMapMemory); LOADD(vkDestroyBuffer); LOADD(vkFreeMemory);
  LOADD(vkResetCommandBuffer); LOADD(vkQueueWaitIdle);

  VkCommandPoolCreateInfo pci = {VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, NULL, VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT, vkctx.queue_family_index};
  if ((r = vkCreateCommandPool_(vkctx.device, &pci, NULL, &cmd_pool)) != VK_SUCCESS) die("vkCreateCommandPool failed (%d)", r);
  VkCommandBufferAllocateInfo cai = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, NULL, cmd_pool, VK_COMMAND_BUFFER_LEVEL_PRIMARY, 1};
  if ((r = vkAllocateCommandBuffers_(vkctx.device, &cai, &cmd)) != VK_SUCCESS) die("vkAllocateCommandBuffers failed (%d)", r);
  VkFenceCreateInfo fci = {VK_STRUCTURE_TYPE_FENCE_CREATE_INFO, NULL, 0};
  if ((r = vkCreateFence_(vkctx.device, &fci, NULL, &fence)) != VK_SUCCESS) die("vkCreateFence failed (%d)", r);

  vkif.interface_type = RETRO_HW_RENDER_INTERFACE_VULKAN;
  vkif.interface_version = RETRO_HW_RENDER_INTERFACE_VULKAN_VERSION;
  vkif.handle = &vkif;
  vkif.instance = instance;
  vkif.gpu = vkctx.gpu ? vkctx.gpu : gpu;
  vkif.device = vkctx.device;
  vkif.get_device_proc_addr = core_gdpa;
  vkif.get_instance_proc_addr = core_gipa;
  vkif.queue = vkctx.queue;
  vkif.queue_index = vkctx.queue_family_index;
  vkif.set_image = vk_set_image;
  vkif.get_sync_index = vk_sync_index;
  vkif.get_sync_index_mask = vk_sync_mask;
  vkif.set_command_buffers = vk_set_cmds;
  vkif.wait_sync_index = vk_wait_sync;
  vkif.lock_queue = vk_lock;
  vkif.unlock_queue = vk_unlock;
  vkif.set_signal_semaphore = vk_set_signal;
}

static void ensure_readback(VkDeviceSize size) {
  if (rb_buf && rb_size >= size) return;
  if (rb_buf) {
    vkDestroyBuffer_(vkctx.device, rb_buf, NULL);
    vkFreeMemory_(vkctx.device, rb_mem, NULL);
  }
  VkBufferCreateInfo bci = {VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, NULL, 0, size, VK_BUFFER_USAGE_TRANSFER_DST_BIT, VK_SHARING_MODE_EXCLUSIVE, 0, NULL};
  if (vkCreateBuffer_(vkctx.device, &bci, NULL, &rb_buf) != VK_SUCCESS) die("readback buffer (%llu bytes)", (unsigned long long)size);
  VkMemoryRequirements req;
  vkGetBufferMemoryRequirements_(vkctx.device, rb_buf, &req);
  VkPhysicalDeviceMemoryProperties mp;
  vkGetPhysicalDeviceMemoryProperties_(vkif.gpu, &mp);
  uint32_t type = UINT32_MAX;
  const VkMemoryPropertyFlags want = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
  for (uint32_t i = 0; i < mp.memoryTypeCount; i++) {
    if ((req.memoryTypeBits & (1u << i)) && (mp.memoryTypes[i].propertyFlags & want) == want) {
      // prefer cached host memory: the CPU reads every byte of it
      if (type == UINT32_MAX || (mp.memoryTypes[i].propertyFlags & VK_MEMORY_PROPERTY_HOST_CACHED_BIT)) type = i;
    }
  }
  if (type == UINT32_MAX) die("no host-visible Vulkan memory");
  VkMemoryAllocateInfo mai = {VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, NULL, req.size, type};
  if (vkAllocateMemory_(vkctx.device, &mai, NULL, &rb_mem) != VK_SUCCESS) die("readback memory");
  if (vkBindBufferMemory_(vkctx.device, rb_buf, rb_mem, 0) != VK_SUCCESS || vkMapMemory_(vkctx.device, rb_mem, 0, VK_WHOLE_SIZE, 0, &rb_ptr) != VK_SUCCESS || !rb_ptr)
    die("readback memory can't be mapped");
  rb_size = size;
}

/** Copy the core's picture into host memory (waits for the GPU). Returns the pixels, or NULL. */
static const uint8_t *readback(int w, int h, int *bgra) {
  if (!cur_image) return NULL;
  VkImage image = cur_image->create_info.image;
  VkFormat fmt = cur_image->create_info.format;
  *bgra = fmt == VK_FORMAT_B8G8R8A8_UNORM || fmt == VK_FORMAT_B8G8R8A8_SRGB;
  static int warned_fmt;
  if (!*bgra && fmt != VK_FORMAT_R8G8B8A8_UNORM && fmt != VK_FORMAT_R8G8B8A8_SRGB && fmt != VK_FORMAT_A8B8G8R8_UNORM_PACK32 && !warned_fmt) {
    warned_fmt = 1; // (4 bytes a pixel is all the readback knows – a wider format would overrun the buffer)
    if (fmt != VK_FORMAT_A8B8G8R8_SRGB_PACK32) die("unexpected picture format from the core (VkFormat %d)", (int)fmt);
  }
  ensure_readback((VkDeviceSize)w * h * 4);
  vkResetCommandBuffer_(cmd, 0);
  VkCommandBufferBeginInfo bi = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, NULL, VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT, NULL};
  vkBeginCommandBuffer_(cmd, &bi);
  VkImageSubresourceRange range = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
  VkImageMemoryBarrier to_src = {VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, NULL, VK_ACCESS_MEMORY_WRITE_BIT | VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
    VK_ACCESS_TRANSFER_READ_BIT, cur_image->image_layout, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, VK_QUEUE_FAMILY_IGNORED, VK_QUEUE_FAMILY_IGNORED, image, range};
  vkCmdPipelineBarrier_(cmd, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1, &to_src);
  VkBufferImageCopy region = {0, 0, 0, {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1}, {0, 0, 0}, {(uint32_t)w, (uint32_t)h, 1}};
  vkCmdCopyImageToBuffer_(cmd, image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, rb_buf, 1, &region);
  VkImageMemoryBarrier back = to_src;
  back.srcAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
  back.dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
  back.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
  back.newLayout = cur_image->image_layout;
  vkCmdPipelineBarrier_(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 0, NULL, 0, NULL, 1, &back);
  vkEndCommandBuffer_(cmd);
  VkCommandBuffer cmds[9];
  uint32_t nc = 0;
  for (unsigned i = 0; i < pending_n && i < 8; i++) cmds[nc++] = pending_cmds[i];
  pending_n = 0;
  cmds[nc++] = cmd;
  VkSubmitInfo si = {VK_STRUCTURE_TYPE_SUBMIT_INFO, NULL, 0, NULL, NULL, nc, cmds, 0, NULL};
  pthread_mutex_lock(&queue_lock);
  VkResult r = vkQueueSubmit_(vkctx.queue, 1, &si, fence);
  pthread_mutex_unlock(&queue_lock);
  if (r == VK_ERROR_DEVICE_LOST) die("the graphics driver stopped the game's GPU work (VK_ERROR_DEVICE_LOST) – GPU: %s", gpu_desc);
  if (r != VK_SUCCESS) {
    static int warned;
    if (!warned++) logf_("vkQueueSubmit failed (%d) – picture skipped", r);
    return NULL;
  }
  r = vkWaitForFences_(vkctx.device, 1, &fence, VK_TRUE, 10ull * 1000 * 1000 * 1000);
  if (r == VK_ERROR_DEVICE_LOST) die("the graphics driver stopped the game's GPU work (VK_ERROR_DEVICE_LOST) – GPU: %s", gpu_desc);
  if (r == VK_TIMEOUT) die("the graphics card didn't finish a picture in 10 seconds (GPU: %s)", gpu_desc);
  vkResetFences_(vkctx.device, 1, &fence);
  return rb_ptr;
}

// ---- video -------------------------------------------------------------------------------------------------------
static int want_frame = 1; // turbo: only every n-th picture is read back and sent
static uint8_t *last_frame; // bench: the last picture
static int last_w, last_h, last_bgra;
static uint64_t frames_shown;

static uint8_t *sw_frame; // the software renderer's picture without its row padding
static size_t sw_cap;

static void video_refresh(const void *data, unsigned w, unsigned h, size_t pitch) {
  if (!data || !w || !h) return; // a dupe: nothing new
  frame_w = (int)w;
  frame_h = (int)h;
  if (!want_frame) return;
  int bgra = 0;
  const uint8_t *px;
  if (data == RETRO_HW_FRAME_BUFFER_VALID) {
    if (renderer == R_SOFTWARE) return;
    px = readback((int)w, (int)h, &bgra);
  } else {
    // the software renderer: XRGB8888 rows in memory (B, G, R, X – the page ignores the 4th byte)
    if (renderer != R_SOFTWARE || pitch < (size_t)w * 4) return;
    bgra = 1;
    px = data;
    if (pitch != (size_t)w * 4) {
      const size_t need = (size_t)w * h * 4;
      if (sw_cap < need) {
        uint8_t *nb = realloc(sw_frame, need);
        if (!nb) return;
        sw_frame = nb, sw_cap = need;
      }
      for (unsigned y = 0; y < h; y++) memcpy(sw_frame + (size_t)y * w * 4, (const uint8_t *)data + y * pitch, (size_t)w * 4);
      px = sw_frame;
    }
  }
  if (!px) return;
  frames_shown++;
  if (!protocol) {
    last_frame = realloc(last_frame, (size_t)w * h * 4);
    memcpy(last_frame, px, (size_t)w * h * 4);
    last_w = (int)w, last_h = (int)h, last_bgra = bgra;
    return;
  }
  uint8_t head[8];
  uint16_t ww = (uint16_t)w, hh = (uint16_t)h;
  uint32_t f = bgra ? 0 : 1;
  memcpy(head, &ww, 2);
  memcpy(head + 2, &hh, 2);
  memcpy(head + 4, &f, 4);
  send_msg2(2, head, 8, px, (uint32_t)(w * h * 4));
}

// ---- environment -------------------------------------------------------------------------------------------------
static void core_log(enum retro_log_level level, const char *fmt, ...) {
  if (level < RETRO_LOG_INFO) return;
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  // warnings and errors always; of the info lines only the renderer's (device, driver, extensions – what a crash on
  // another PC needs)
  if (level < RETRO_LOG_WARN && !strstr(buf, "Vulkan") && !strstr(buf, "Render")) return;
  if (strstr(buf, "Fetching variable")) return; // the core options twincable leaves at their defaults (an error line each)
  logf_("[core] %s", buf);
}

static bool environment(unsigned cmd, void *data) {
  if (IS(cmd, RETRO_ENVIRONMENT_GET_CAN_DUPE)) { *(bool *)data = true; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY)) { *(const char **)data = opt_system; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY)) { *(const char **)data = opt_save; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_CORE_ASSETS_DIRECTORY)) { *(const char **)data = opt_system; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_PIXEL_FORMAT)) return *(enum retro_pixel_format *)data == RETRO_PIXEL_FORMAT_XRGB8888;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS) || IS(cmd, RETRO_ENVIRONMENT_SET_CONTROLLER_INFO)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_HW_RENDER)) {
    struct retro_hw_render_callback *cb = data;
    if (cb->context_type != RETRO_HW_CONTEXT_VULKAN) return false;
    hw = *cb;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER)) { *(unsigned *)data = RETRO_HW_CONTEXT_VULKAN; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_HW_RENDER_CONTEXT_NEGOTIATION_INTERFACE)) {
    negotiation = data;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_HW_RENDER_INTERFACE)) {
    if (!vkif.device) return false;
    *(const struct retro_hw_render_interface_vulkan **)data = &vkif;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_VARIABLE)) {
    struct retro_variable *v = data;
    v->value = core_option(v->key);
    return v->value != NULL;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE)) { *(bool *)data = false; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION)) { *(unsigned *)data = 0; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_VARIABLES)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_LOG_INTERFACE)) { ((struct retro_log_callback *)data)->log = core_log; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_GEOMETRY)) {
    const struct retro_game_geometry *g = data;
    frame_w = (int)g->base_width, frame_h = (int)g->base_height;
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_SET_MEMORY_MAPS)) {
    const struct retro_memory_map *m = data;
    free(memmap);
    memmap_n = m->num_descriptors;
    memmap = calloc(memmap_n ? memmap_n : 1, sizeof *memmap);
    memcpy(memmap, m->descriptors, memmap_n * sizeof *memmap);
    return true;
  }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS) || IS(cmd, RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_INPUT_BITMASKS)) return true;
  if (IS(cmd, RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE)) { *(int *)data = 1 | 2; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_FASTFORWARDING)) { *(bool *)data = false; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_LANGUAGE)) { *(unsigned *)data = RETRO_LANGUAGE_ENGLISH; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_USERNAME)) { *(const char **)data = "twincable"; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION)) { *(unsigned *)data = 1; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_MESSAGE)) { logf_("[core message] %s", ((const struct retro_message *)data)->msg); return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SET_MESSAGE_EXT)) { logf_("[core message] %s", ((const struct retro_message_ext *)data)->msg); return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_GET_TARGET_REFRESH_RATE)) { *(float *)data = 60.0f; return true; }
  if (IS(cmd, RETRO_ENVIRONMENT_SHUTDOWN)) { _exit(0); }
  return false;
}

// ---- memory reads ----------------------------------------------------------------------------------------------
// twincable's build of the core exports these (native/azahar-patch): reads through the game process's page table, so
// the heaps the game allocates after loading are readable too. The official core only has the memory map from load.
static bool (*twincable_read_memory)(uint32_t addr, void *out, uint32_t size);
static uint64_t (*twincable_title_id)(void);
// Save states that stop the game only while its memory is copied (native/azahar-patch/twincable-state.patch): zstd runs on
// a thread of the core's own and the state goes out once it is packed, a few frames later. Without them (an older core)
// retro_serialize_size packs it between two frames – 0.4 s without sound or pictures on a Windows PC.
static int (*twincable_state_begin)(void);
static int64_t (*twincable_state_poll)(void);
static bool (*twincable_state_take)(void *out, size_t size);

static const uint8_t *mem_at(uint32_t addr, uint32_t len) {
  for (unsigned i = 0; i < memmap_n; i++) {
    const struct retro_memory_descriptor *d = &memmap[i];
    if (!d->ptr || addr < d->start || (uint64_t)addr + len > (uint64_t)d->start + d->len) continue;
    return (const uint8_t *)d->ptr + d->offset + (addr - d->start);
  }
  return NULL;
}

// ---- memory writes (cheats) ----------------------------------------------------------------------------------------
// twincable's WRITE command: a few bytes inside one page of the game's heaps (the bag). Every write
//   1. only into the game's heaps (application heap, linear heaps) – nothing else is ever touched
//   2. only while the bytes there are still what twincable expects (`old`) – read through the core, so the game hasn't
//      changed them since twincable looked
//   3. through twincable_write_memory (native/azahar-patch): the core's own memory system writes at the game's virtual
//      address – the process's page table, so the application heap (X/Y, Omega Ruby / Alpha Sapphire) and the linear
//      heaps (Sun / Moon …) alike, on every OS – and the change is read back through the core
// Between two frames on the core's thread, like the reads.
//
// An older core (twincable 2.7.2 and before) has no write call: then the page is looked for in the core's FCRAM block
// (one allocation of 256 MB – every heap page of the game is a page of it, and the stack page in the memory map points
// into it) by its content. Every page with the same 4 KB is tried – the new bytes go in, and only the page whose change
// shows at the game's address keeps them; every other one is put back at once. The block's bounds come from the OS
// (the read-write memory around that stack page). The scan reads the block once at most (a few ms).
#define MAX_WRITE 256
#define MAX_TRIES 64
static const uint32_t write_ranges[][2] = {
  {0x08000000, 0x10000000}, // application heap (X/Y, Omega Ruby / Alpha Sapphire)
  {0x14000000, 0x1C000000}, // linear heap
  {0x30000000, 0x40000000}, // linear heap, newer kernels (Sun / Moon, Ultra Sun / Ultra Moon)
};
static bool (*twincable_write_memory)(uint32_t addr, const void *data, uint32_t size);

/** Is [addr, addr+len) inside one page of the game's heaps? */
static bool write_allowed(uint32_t addr, uint32_t len) {
  if (!len || len > MAX_WRITE || (addr & 0xFFF) + len > 0x1000) return false;
  for (unsigned i = 0; i < sizeof write_ranges / sizeof *write_ranges; i++)
    if (addr >= write_ranges[i][0] && (uint64_t)addr + len <= write_ranges[i][1]) return true;
  return false;
}

/** A host pointer into the core's FCRAM block: the backing of a heap / stack region in the memory map. */
static uintptr_t fcram_anchor(void) {
  for (unsigned i = 0; i < memmap_n; i++) {
    const struct retro_memory_descriptor *d = &memmap[i];
    // (VRAM 0x1F000000 and the DSP's memory are other blocks)
    if (d->ptr && d->len >= 0x1000 && (d->start < 0x14000000 || (d->start >= 0x30000000 && d->start < 0x40000000)))
      return (uintptr_t)d->ptr + d->offset;
  }
  return 0;
}

/** The read-write memory around `p`, joined with the regions right before and after it, at most `span` each way. */
static int rw_range(uintptr_t p, uintptr_t span, uintptr_t *lo, uintptr_t *hi) {
  uintptr_t s, e;
  if (!compat_rw_region(p, &s, &e)) return 0;
  const uintptr_t min = p > span ? p - span : 0, max = p + span;
  for (int i = 0; i < 64 && s > min; i++) {
    uintptr_t s2, e2;
    if (!compat_rw_region(s - 1, &s2, &e2) || e2 != s) break;
    s = s2;
  }
  for (int i = 0; i < 64 && e < max; i++) {
    uintptr_t s2, e2;
    if (!compat_rw_region(e, &s2, &e2) || s2 != e) break;
    e = e2;
  }
  *lo = s < min ? min : s;
  *hi = e > max ? max : e;
  return 1;
}

/** The fallback for a core without twincable_write_memory: the page found by its content (see above). */
static const char *scan_write(uint32_t addr, const uint8_t *page, const uint8_t *old, const uint8_t *val, uint32_t len) {
  const uintptr_t anchor = fcram_anchor();
  uint8_t now[MAX_WRITE];
  const uint32_t off = addr & 0xFFF;
  uintptr_t lo, hi;
  if (!anchor || !rw_range(anchor, 0x10000000, &lo, &hi)) return "unsupported";
  // pages of the block lie a multiple of 4 KB from the anchor
  uintptr_t first = anchor - ((anchor - lo) / 0x1000) * 0x1000;
  int tries = 0;
  for (uintptr_t c = first; c + 0x1000 <= hi && tries < MAX_TRIES; c += 0x1000) {
    uint8_t *h = (uint8_t *)c;
    if (h[off] != page[off] || memcmp(h, page, 0x1000)) continue;
    tries++;
    memcpy(h + off, val, len);
    if (twincable_read_memory(addr, now, len) && !memcmp(now, val, len)) return "ok";
    memcpy(h + off, old, len); // a copy of the page somewhere else – put back
  }
  return "notFound";
}

/**
 * One write: "ok", or why not – "range" (outside the game's heaps, or not mapped), "changed" (the game holds other
 * bytes there now), "unsupported" (a core without twincable's memory calls), "failed" (the core refused the write or it
 * didn't read back), "notFound" (the fallback scan didn't find the page).
 */
static const char *mem_write(uint32_t addr, const uint8_t *old, const uint8_t *val, uint32_t len) {
  if (!write_allowed(addr, len)) return "range";
  if (!twincable_read_memory) return "unsupported";
  uint8_t page[0x1000], now[MAX_WRITE];
  const uint32_t vpage = addr & ~0xFFFu, off = addr & 0xFFF;
  if (!twincable_read_memory(vpage, page, sizeof page)) return "range"; // (not mapped)
  if (memcmp(page + off, old, len)) return "changed";
  if (!twincable_write_memory) return scan_write(addr, page, old, val, len);
  if (!twincable_write_memory(addr, val, len)) return "failed";
  if (!twincable_read_memory(addr, now, len) || memcmp(now, val, len)) return "failed";
  return "ok";
}

#define MAX_WRITES 16
static struct pending_write { uint32_t id, addr, len; uint8_t old[MAX_WRITE], val[MAX_WRITE]; } writes[MAX_WRITES]; // (cmd_lock)
static unsigned writes_n;

#define MAX_WATCH 16
static pthread_mutex_t cmd_lock = PTHREAD_MUTEX_INITIALIZER;
static struct watch_region { uint32_t addr, len; } watch[MAX_WATCH]; // written by the reader thread (cmd_lock)
static unsigned watch_n;

static void send_mem(void) {
  // a copy: the reader thread may change the list meanwhile (sizes computed from one list, copied by another overran
  // the buffer)
  struct watch_region w[MAX_WATCH];
  pthread_mutex_lock(&cmd_lock);
  unsigned wn = watch_n;
  memcpy(w, watch, sizeof w);
  pthread_mutex_unlock(&cmd_lock);
  if (!wn) return;
  size_t total = 4;
  for (unsigned i = 0; i < wn; i++) total += 8 + w[i].len;
  uint8_t *b = malloc(total), *p = b;
  if (!b) return;
  uint32_t n = wn;
  memcpy(p, &n, 4), p += 4;
  for (unsigned i = 0; i < wn; i++) {
    uint32_t len = w[i].len;
    memcpy(p, &w[i].addr, 4);
    uint8_t *lenp = p + 4, *data = p + 8;
    if (twincable_read_memory) {
      if (!twincable_read_memory(w[i].addr, data, len)) len = 0; // unmapped (title screen, another update's address)
    } else {
      const uint8_t *src = mem_at(w[i].addr, len);
      if (src) memcpy(data, src, len);
      else len = 0;
    }
    memcpy(lenp, &len, 4);
    p = data + len;
  }
  send_msg(4, b, (uint32_t)(p - b));
  free(b);
}

// ---- the game's RomFS reads (twincable's "music from the ROM") ------------------------------------------------------
// The core notes every RomFS read the game makes (native/azahar-patch/twincable-romfs.patch, a lock-free ring); the host
// drains it after each frame – tagged with that frame – and sends what came ten times a second (ROMFS), right before
// the frame's sound, so the page knows exactly which sound the reads belong to. Nothing here waits on the core or
// changes how the game runs. ROMREAD asks for RomFS bytes (the tables, a stream's header and data): read between
// frames, a little per frame.
static uint32_t (*twincable_romfs_reads)(uint64_t *out, uint32_t max);
static uint32_t (*twincable_romfs_read)(uint32_t tag, uint64_t offset, void *out, uint32_t size);
static uint64_t (*twincable_romfs_size)(uint32_t tag);
#define ROMFS_MAX 1024     // reads kept between two sends (a loading screen reads hundreds a second)
#define ROMREAD_MAX (1u << 20)
#define ROMREAD_BUDGET (2u << 20) // bytes of ROMREAD answered per frame (a few ms of disk at most)
#define MAX_ROMREADS 32
static uint8_t romfs_buf[16 + ROMFS_MAX * 32];
static uint32_t romfs_n;
static uint64_t romfs_lost; // reads that didn't fit until the next send (diagnostics: the page sees the serial gap)
static struct romread { uint32_t id, tag, len; uint64_t offset; } romreads[MAX_ROMREADS]; // (cmd_lock)
static unsigned romreads_n;

/** After a frame: the reads the core noted during it, into the next ROMFS message. */
static void romfs_drain(uint64_t frame) {
  if (!twincable_romfs_reads) return;
  uint64_t r[3 * 64];
  for (;;) {
    uint32_t n = twincable_romfs_reads(r, 64);
    for (uint32_t i = 0; i < n; i++) {
      if (romfs_n >= ROMFS_MAX) {
        romfs_lost++;
        continue;
      }
      uint8_t *e = romfs_buf + 16 + romfs_n * 32;
      const uint32_t len = (uint32_t)r[3 * i + 2], tag = (uint32_t)(r[3 * i + 2] >> 32);
      memcpy(e, &r[3 * i], 8), memcpy(e + 8, &r[3 * i + 1], 8), memcpy(e + 16, &len, 4), memcpy(e + 20, &tag, 4), memcpy(e + 24, &frame, 8);
      romfs_n++;
    }
    if (n < 64) break;
  }
}

/** Ten times a second (reads came), or twice a second (an empty one: the frame, for the page's clock). */
static int romfs_now; // send with the next frame (fast-forward started or ended: the page lines the music up again)
static void romfs_send(uint64_t frame, double t, int turbo) {
  static double last_send, last_empty;
  if (!twincable_romfs_reads) return;
  if (!romfs_now && (romfs_n ? (t - last_send < 0.1 && romfs_n < ROMFS_MAX) : t - last_empty < 0.5)) return;
  romfs_now = 0;
  last_send = last_empty = t;
  const uint32_t flags = turbo ? 1 : 0; // (the page lines the music up with 1× frames only)
  memcpy(romfs_buf, &frame, 8);
  memcpy(romfs_buf + 8, &romfs_n, 4);
  memcpy(romfs_buf + 12, &flags, 4);
  send_msg(9, romfs_buf, 16 + romfs_n * 32);
  romfs_n = 0;
}

/** The ROMREADs that came since the last frame (as many as the budget allows – the rest wait for the next one). */
static void romfs_answer(void) {
  static struct romread q[MAX_ROMREADS];
  pthread_mutex_lock(&cmd_lock);
  unsigned n = 0;
  uint32_t bytes = 0;
  while (n < romreads_n && (n == 0 || bytes + romreads[n].len <= ROMREAD_BUDGET)) bytes += romreads[n].len, q[n] = romreads[n], n++;
  memmove(romreads, romreads + n, (romreads_n - n) * sizeof *romreads);
  romreads_n -= n;
  pthread_mutex_unlock(&cmd_lock);
  static uint8_t *buf;
  if (n && !buf) buf = malloc(16 + ROMREAD_MAX);
  for (unsigned i = 0; i < n; i++) {
    uint8_t head[16] = {0};
    uint32_t status = 0, got = 0;
    uint64_t size = 0;
    if (!twincable_romfs_read || !buf) status = 1; // (no patched core – or out of memory: an answer without bytes)
    else if (!(size = twincable_romfs_size(q[i].tag))) status = 2;
    else if (q[i].len) got = twincable_romfs_read(q[i].tag, q[i].offset, buf, q[i].len);
    memcpy(head, &q[i].id, 4), memcpy(head + 4, &status, 4), memcpy(head + 8, &size, 8);
    send_msg2(10, head, 16, buf, got);
  }
}

// ---- commands from twincable ---------------------------------------------------------------------------------------
static float speed = 1.0f;
static int want_save, want_quit, want_reset;
static int sfx_want; // the page wants the sound effects without the music while fast-forwarding (SFX)
#define MAX_MUSIC_RANGES 8192
static struct music_ranges { uint32_t tag, n; uint64_t *pairs; } music_pending[8]; // (cmd_lock) MUSIC, applied between frames
static unsigned music_pending_n;
static uint8_t *load_data;
static size_t load_len;

static int read_full(void *p, size_t n) {
  uint8_t *b = p;
  while (n) {
    compat_ssize r = compat_read(0, b, n);
    if (r == 0) return 0;
    if (r < 0) {
      if (errno == EINTR) continue;
      return 0;
    }
    b += r;
    n -= (size_t)r;
  }
  return 1;
}

static void *reader(void *arg) {
  (void)arg;
  for (;;) {
    uint32_t h[2];
    if (!read_full(h, 8)) break;
    if (h[1] > 512u * 1024 * 1024) break;
    uint8_t *p = h[1] ? malloc(h[1]) : NULL;
    if (h[1] && !p) break; // out of memory: as if twincable had gone
    if (h[1] && !read_full(p, h[1])) {
      free(p);
      break;
    }
    pthread_mutex_lock(&cmd_lock);
    switch (h[0]) {
    case 1:
      if (h[1] >= 17) {
        pthread_mutex_lock(&in_lock);
        if (p[16] && !input.pressed) touch_latch = TOUCH_MIN_FRAMES;
        memcpy(&input.buttons, p, 4);
        memcpy(&input.lx, p + 4, 2), memcpy(&input.ly, p + 6, 2), memcpy(&input.rx, p + 8, 2), memcpy(&input.ry, p + 10, 2);
        if (p[16] || !touch_latch) memcpy(&input.px, p + 12, 2), memcpy(&input.py, p + 14, 2);
        input.pressed = p[16];
        pthread_mutex_unlock(&in_lock);
      }
      break;
    case 2:
      if (h[1] >= 4) {
        float v;
        memcpy(&v, p, 4);
        speed = isfinite(v) ? v : v > 0 ? 1000.0f : 1.0f; // NaN would stop the frame pacing for good
      }
      break;
    case 3: want_save++; break; // (each ask gets its answer)
    case 4: free(load_data); load_data = p; load_len = h[1]; p = NULL; break;
    case 5:
      if (h[1] >= 4) {
        uint32_t n;
        memcpy(&n, p, 4);
        if (n > MAX_WATCH) n = MAX_WATCH;
        if (h[1] >= 4 + n * 8) {
          for (uint32_t i = 0; i < n; i++) {
            memcpy(&watch[i].addr, p + 4 + i * 8, 4);
            memcpy(&watch[i].len, p + 8 + i * 8, 4);
            if (watch[i].len > 64 * 1024) watch[i].len = 64 * 1024;
          }
          watch_n = n;
        }
      }
      break;
    case 6: want_quit = 1; break;
    case 7: want_reset = 1; break;
    case 8: break; // FRAMESKIP (older pages): pictures in turbo are paced by time now
    case 9: // WRITE u32 id, u32 addr, u32 len, old[len], new[len]
      if (h[1] >= 12) {
        uint32_t id, addr, len;
        memcpy(&id, p, 4), memcpy(&addr, p + 4, 4), memcpy(&len, p + 8, 4);
        if (len && len <= MAX_WRITE && h[1] == 12 + 2 * len) {
          if (writes_n < MAX_WRITES) {
            struct pending_write *w = &writes[writes_n++];
            w->id = id, w->addr = addr, w->len = len;
            memcpy(w->old, p + 12, len);
            memcpy(w->val, p + 12 + len, len);
          } else {
            send_event("{\"event\":\"written\",\"id\":%u,\"ok\":false,\"why\":\"busy\"}", id);
          }
        }
      }
      break;
    case 11: // MUSIC u32 tag, u32 n, n × { u64 start, u64 end }
      if (h[1] >= 8) {
        uint32_t tag, n;
        memcpy(&tag, p, 4), memcpy(&n, p + 4, 4);
        if (n <= MAX_MUSIC_RANGES && h[1] >= 8 + n * 16 && music_pending_n < 8) {
          uint64_t *pairs = n ? malloc(n * 16) : NULL;
          if (!n || pairs) {
            if (n) memcpy(pairs, p + 8, n * 16);
            music_pending[music_pending_n++] = (struct music_ranges){tag, n, pairs};
          }
        }
      }
      break;
    case 12: // SFX u32 on
      if (h[1] >= 4) {
        uint32_t on;
        memcpy(&on, p, 4);
        sfx_want = on != 0;
      }
      break;
    case 10: // ROMREAD u32 id, u32 tag, u64 offset, u32 length
      if (h[1] >= 20) {
        struct romread r;
        memcpy(&r.id, p, 4), memcpy(&r.tag, p + 4, 4), memcpy(&r.offset, p + 8, 8), memcpy(&r.len, p + 16, 4);
        if (r.len > ROMREAD_MAX) r.len = ROMREAD_MAX;
        if (romreads_n < MAX_ROMREADS) romreads[romreads_n++] = r;
        else { // (too many at once: answered "can't" right away – the page asks again)
          uint8_t b[16] = {0};
          const uint32_t st = 1;
          memcpy(b, &r.id, 4), memcpy(b + 4, &st, 4);
          send_msg(10, b, 16);
        }
      }
      break;
    }
    pthread_mutex_unlock(&cmd_lock);
    free(p);
  }
  pthread_mutex_lock(&cmd_lock);
  want_quit = 1; // twincable closed the pipe
  pthread_mutex_unlock(&cmd_lock);
  return NULL;
}

// ---- main --------------------------------------------------------------------------------------------------------
static double now_s(void) { return compat_now(); }

static void dump_ppm(const char *path) {
  if (!last_frame) return;
  FILE *f = compat_fopen(path, "wb");
  if (!f) return;
  fprintf(f, "P6\n%d %d\n255\n", last_w, last_h);
  for (int i = 0; i < last_w * last_h; i++) {
    const uint8_t *p = last_frame + i * 4;
    uint8_t rgb[3] = {last_bgra ? p[2] : p[0], p[1], last_bgra ? p[0] : p[2]};
    fwrite(rgb, 1, 3, f);
  }
  fclose(f);
}

#define SYM(field, name) core.field = dlsym(lib, name); if (!core.field) die("%s missing in the core", name)

int main(int argc, char **argv) {
  argv = compat_utf8_argv(&argc, argv);
  for (int i = 1; i + 1 < argc; i += 2) {
    if (!strcmp(argv[i], "--core")) opt_core = argv[i + 1];
    else if (!strcmp(argv[i], "--vulkan")) opt_vulkan = argv[i + 1];
    else if (!strcmp(argv[i], "--rom")) opt_rom = argv[i + 1];
    else if (!strcmp(argv[i], "--system")) opt_system = argv[i + 1];
    else if (!strcmp(argv[i], "--save")) opt_save = argv[i + 1];
    else if (!strcmp(argv[i], "--bench")) opt_bench = atoi(argv[i + 1]);
    else if (!strcmp(argv[i], "--dump")) opt_dump = argv[i + 1];
    else if (!strcmp(argv[i], "--scale")) opt_scale = atoi(argv[i + 1]);
    else if (!strcmp(argv[i], "--renderer")) opt_renderer = argv[i + 1];
  }
  if (!opt_renderer) opt_renderer = getenv("CTRHOST_RENDERER");
  if (opt_renderer && !strcmp(opt_renderer, "compat")) renderer = R_COMPAT;
  else if (opt_renderer && !strcmp(opt_renderer, "software")) renderer = R_SOFTWARE;
  if (!opt_core || (!opt_vulkan && renderer != R_SOFTWARE) || !opt_rom || !opt_system || !opt_save) {
    fprintf(stderr, "usage: ctrhost --core <lib> --vulkan <lib> --rom <file> --system <dir> --save <dir> [--scale n] [--renderer vulkan|compat|software] [--bench frames --dump out.ppm]\n");
    return 2;
  }
  if (opt_scale < 1 || opt_scale > 4) opt_scale = 1;
  snprintf(scale_str, sizeof scale_str, "%d", opt_scale);
  if (opt_bench) protocol = 0;
  compat_init();
  compat_crash_handler(on_crash);
  if (getenv("CTRHOST_DEBUG")) debug_input = 400;

  logf_("renderer: %s", renderer == R_VULKAN ? "vulkan (the standalone Azahar's device)" : renderer == R_COMPAT ? "compat (Vulkan, the core's own device)" : "software (Azahar's software renderer, no GPU)");
  if (renderer != R_SOFTWARE) {
    stage = "loading the Vulkan library";
    load_vk(opt_vulkan);
  }
  stage = "loading the core";
  void *lib = dlopen(opt_core, RTLD_NOW | RTLD_LOCAL);
  if (!lib) die("core not loadable: %s", dlerror());
  SYM(init, "retro_init"); SYM(deinit, "retro_deinit"); SYM(set_environment, "retro_set_environment");
  SYM(set_video_refresh, "retro_set_video_refresh"); SYM(set_audio_sample, "retro_set_audio_sample");
  SYM(set_audio_sample_batch, "retro_set_audio_sample_batch"); SYM(set_input_poll, "retro_set_input_poll");
  SYM(set_input_state, "retro_set_input_state"); SYM(get_system_av_info, "retro_get_system_av_info");
  SYM(load_game, "retro_load_game"); SYM(unload_game, "retro_unload_game"); SYM(run, "retro_run");
  SYM(reset, "retro_reset"); SYM(serialize_size, "retro_serialize_size"); SYM(serialize, "retro_serialize");
  SYM(unserialize, "retro_unserialize");
  twincable_read_memory = dlsym(lib, "twincable_read_memory");
  twincable_title_id = dlsym(lib, "twincable_title_id");
  twincable_state_begin = dlsym(lib, "twincable_state_begin");
  twincable_state_poll = dlsym(lib, "twincable_state_poll");
  twincable_state_take = dlsym(lib, "twincable_state_take");
  if (!twincable_state_begin || !twincable_state_poll || !twincable_state_take) twincable_state_begin = NULL;
  twincable_write_memory = dlsym(lib, "twincable_write_memory");
  twincable_romfs_reads = dlsym(lib, "twincable_romfs_reads");
  twincable_romfs_read = dlsym(lib, "twincable_romfs_read");
  twincable_romfs_size = dlsym(lib, "twincable_romfs_size");
  if (!twincable_romfs_read || !twincable_romfs_size) twincable_romfs_reads = NULL; // (all three or none)
  twincable_audio_music_ranges = dlsym(lib, "twincable_audio_music_ranges");
  twincable_audio_mute_music = dlsym(lib, "twincable_audio_mute_music");
  twincable_audio_frame_flags = dlsym(lib, "twincable_audio_frame_flags");
  twincable_audio_music_state = dlsym(lib, "twincable_audio_music_state");
  if (!twincable_audio_music_ranges || !twincable_audio_mute_music || !twincable_audio_frame_flags || !twincable_romfs_reads) twincable_audio_mute_music = NULL; // (all or none)
  logf_("sound effects without the music (fast-forward): %s", twincable_audio_mute_music ? "yes" : "no (a core without twincable_audio_mute_music)");
  logf_("RomFS reads (music from the ROM): %s", twincable_romfs_reads ? "yes" : "no (a core without twincable_romfs_reads)");
  logf_("memory writes (cheats): %s", twincable_write_memory ? "through the core (twincable_write_memory)"
                                      : twincable_read_memory ? "page scan (a core without twincable_write_memory)" : "none (Azahar's own core)");

  core.set_environment(environment);
  core.set_video_refresh(video_refresh);
  core.set_audio_sample(audio_sample);
  core.set_audio_sample_batch(audio_batch);
  core.set_input_poll(input_poll);
  core.set_input_state(input_state);
  stage = "starting the core";
  core.init();

  struct retro_game_info info = {opt_rom, NULL, 0, NULL};
  stage = "opening the game";
  if (!core.load_game(&info)) die("the core couldn't load the game");
  if (renderer == R_SOFTWARE) {
    // (the software path loads the game in retro_load_game – no device, no context_reset)
    if (hw.context_type == RETRO_HW_CONTEXT_VULKAN) die("the core asked for Vulkan in software mode");
  } else {
    if (hw.context_type != RETRO_HW_CONTEXT_VULKAN) die("the core didn't ask for Vulkan");
    vk_setup();
    stage = "starting the renderer (the core loads the game)";
    if (hw.context_reset) hw.context_reset(); // the core loads the game here (Vulkan path)
    logf_("Vulkan: renderer started – %u images created through wrap_create_image, %u with queue family fields cleared", images_created, images_fixed);
  }

  struct retro_system_av_info av;
  memset(&av, 0, sizeof av);
  core.get_system_av_info(&av);
  double fps = av.timing.fps > 1 ? av.timing.fps : 60.0;
  send_event("{\"event\":\"loaded\",\"width\":%u,\"height\":%u,\"fps\":%.4f,\"sampleRate\":%.1f,\"maps\":%u,\"memory\":%s,\"renderer\":\"%s\",\"romfs\":%s,\"sfx\":%s}",
             av.geometry.base_width, av.geometry.base_height, fps, av.timing.sample_rate, memmap_n, twincable_read_memory ? "true" : "false", RENDERER_NAMES[renderer],
             twincable_romfs_reads ? "true" : "false", twincable_audio_mute_music ? "true" : "false");

  if (opt_bench) {
    double t0 = now_s();
    stage = "running the game (bench)";
    for (int i = 0; i < opt_bench; i++) {
      want_frame = i == opt_bench - 1 || (i % 60) == 0;
      core.run();
    }
    double dt = now_s() - t0;
    fprintf(stderr, "bench: %d frames in %.2f s = %.1f fps (%.0f%% of %.2f), %d×%d, %u memory regions\n", opt_bench, dt, opt_bench / dt,
            100.0 * opt_bench / dt / fps, fps, frame_w, frame_h, memmap_n);
    for (unsigned i = 0; i < memmap_n; i++) fprintf(stderr, "  map %08llx +%08llx\n", (unsigned long long)memmap[i].start, (unsigned long long)memmap[i].len);
    if (twincable_title_id) fprintf(stderr, "title %016llX\n", (unsigned long long)twincable_title_id());
    if (renderer != R_SOFTWARE) fprintf(stderr, "images created through wrap_create_image: %u (%u fixed)\n", images_created, images_fixed);
    if (twincable_read_memory) {
      static const uint32_t probe[] = {0x08000000, 0x08CE1CE8, 0x08CFB26C, 0x14000000, 0x30000000, 0x34195E10, 0x33F7FA44};
      for (unsigned i = 0; i < sizeof probe / sizeof *probe; i++) {
        uint8_t b[16];
        bool ok = twincable_read_memory(probe[i], b, 16);
        fprintf(stderr, "  read %08X: %s", probe[i], ok ? "" : "unmapped");
        if (ok) for (int k = 0; k < 16; k++) fprintf(stderr, "%02x", b[k]);
        fprintf(stderr, "\n");
      }
    }
    if (opt_dump) dump_ppm(opt_dump);
    _exit(0);
  }

  stage = "running the first frames";
  pthread_t th;
  pthread_create(&th, NULL, reader, NULL);
  double next = now_s();
  uint64_t frame = 0;
  const double sample_rate = av.timing.sample_rate > 0 ? av.timing.sample_rate : 32728;
  double stat_t = now_s(), last_shown = 0, last_mem = 0, last_audio = now_s();
  uint64_t stat_frames = 0;
  int was_turbo = 0;
  // 1× runs at the pace the core makes its sound at: Azahar says 60 fps, but a 3DS frame is 547 samples at 32728 Hz
  // (59.83 fps) – paced at 60 the game made 0.3 % more sound than real time, and every minute or so the page had to
  // drop a stretch of it. Measured on the frames that have sound (a quiet core, the first frames: not counted).
  double pace_fps = fps;
  uint64_t pace_frames = 0, pace_samples = 0;
  for (;;) {
    pthread_mutex_lock(&cmd_lock);
    float sp = speed;
    int quit = want_quit, save = want_save, reset = want_reset;
    uint8_t *ld = load_data;
    size_t ll = load_len;
    want_save = want_reset = 0;
    load_data = NULL;
    const int sfx = sfx_want;
    struct music_ranges mq[8];
    const unsigned mn = music_pending_n;
    memcpy(mq, music_pending, mn * sizeof *mq);
    music_pending_n = 0;
    static struct pending_write wq[MAX_WRITES];
    unsigned wn = writes_n;
    memcpy(wq, writes, wn * sizeof *wq);
    writes_n = 0;
    pthread_mutex_unlock(&cmd_lock);
    for (unsigned i = 0; i < mn; i++) {
      if (twincable_audio_mute_music) twincable_audio_music_ranges(mq[i].tag, mq[i].pairs, mq[i].n);
      free(mq[i].pairs);
    }
    if (quit) break;
    for (unsigned i = 0; i < wn; i++) {
      const char *r = mem_write(wq[i].addr, wq[i].old, wq[i].val, wq[i].len);
      const bool ok = !strcmp(r, "ok");
      if (ok) logf_("memory write: %u bytes at %08X", wq[i].len, wq[i].addr);
      send_event("{\"event\":\"written\",\"id\":%u,\"addr\":%u,\"len\":%u,\"ok\":%s,\"why\":\"%s\"}", wq[i].id, wq[i].addr, wq[i].len, ok ? "true" : "false", r);
    }
    if (reset) core.reset();
    if (ld) {
      bool ok = core.unserialize(ld, ll);
      free(ld);
      send_event("{\"event\":\"stateLoaded\",\"ok\":%s}", ok ? "true" : "false");
    }
    static int state_asked; // save states asked for and not answered yet (the page asks one at a time)
    static double state_t0, state_t1;
    if (save) {
      if (twincable_state_begin) {
        state_t0 = now_s();
        const int r = state_asked ? 1 : twincable_state_begin(); // (one still being packed answers this ask too)
        state_t1 = now_s();
        if (r < 0) for (int i = 0; i < save; i++) send_msg(5, NULL, 0);
        else state_asked += save;
      } else {
        const double t0 = now_s();
        size_t n = core.serialize_size();
        uint8_t *b = n ? malloc(n) : NULL;
        const bool ok = b && core.serialize(b, n);
        for (int i = 0; i < save; i++) send_msg(5, ok ? b : NULL, ok ? (uint32_t)n : 0);
        free(b);
        logf_("save state: %zu bytes, %.0f ms between two frames", n, (now_s() - t0) * 1000);
      }
    }
    if (state_asked) {
      const int64_t n = twincable_state_poll();
      if (n != 0) {
        uint8_t *b = n > 0 ? malloc((size_t)n) : NULL;
        const bool ok = b && twincable_state_take(b, (size_t)n);
        for (; state_asked > 0; state_asked--) send_msg(5, ok ? b : NULL, ok ? (uint32_t)n : 0);
        free(b);
        logf_("save state: %lld bytes, %.0f ms between two frames, packed %.0f ms later", (long long)n, (state_t1 - state_t0) * 1000, (now_s() - state_t1) * 1000);
      }
    }
    if (sp <= 0.0f) { // paused
      compat_sleep(0.01);
      next = now_s();
      last_audio = next;
      continue;
    }
    const int turbo = sp > 1.01f;
    if (turbo != was_turbo) { // a fresh start for the sped-up sound: the asked-for speed until it is measured
      was_turbo = turbo;
      romfs_now = 1;
      ff_reset(turbo ? (sp > FF_MAXK ? FF_MAXK : sp) : 1);
      if (turbo) send_event("{\"event\":\"ffrate\",\"k\":%.4f}", ff.k);
    } else if (turbo && ff.kin > sp) {
      ff.kin = sp; // a slower step: the game won't go faster than asked (a faster one: measured as it comes)
    }
    // the sound effects without the music: only while fast-forwarding and asked for – at 1× the core's sound is never
    // touched (the page lines its music track up with it)
    const int mute = sfx && turbo && twincable_audio_mute_music;
    if (mute != sfx_muting) {
      sfx_muting = mute;
      if (twincable_audio_mute_music) twincable_audio_mute_music((uint32_t)mute);
    }
    sfx_flags = 0;
    sfx_n = 0;
    double t = now_s();
    // turbo: a picture for the screen about 60 times a second, not one per emulated frame (at 1×: every one)
    want_frame = !turbo || t - last_shown >= 1.0 / 62;
    if (want_frame) last_shown = t;
    core.run();
    pthread_mutex_lock(&in_lock);
    if (touch_latch > 0) touch_latch--;
    pthread_mutex_unlock(&in_lock);
    if (++frame == 120) stage = "running the game";
    stat_frames++;
    t = now_s();
    romfs_drain(frame);
    romfs_send(frame, t, turbo); // (before the frame's sound: the page lines the reads up with it)
    romfs_answer();
    if (!turbo) {
      if (audio_n) send_msg(3, audio_buf, (uint32_t)(audio_n * sizeof *audio_buf));
      if (audio_n && frame > 120) {
        pace_frames++;
        pace_samples += audio_n / 2;
      }
    } else {
      // fast-forward: the core's sound as it is (the turbo mixer's music, see FFSOUND) – and sped up, resampled to real
      // time (see ff_frame)
      if (audio_n && sfx_muting) {
        // the sound effects alone (SFX): the frame's sound without the music voices, where new sounds began in it
        uint32_t head[2 + MAX_ONSETS];
        head[0] = sfx_flags;
        head[1] = sfx_n;
        memcpy(head + 2, sfx_onsets, sfx_n * 4);
        send_msg2(11, head, 8 + sfx_n * 4, audio_buf, (uint32_t)(audio_n * sizeof *audio_buf));
      } else if (audio_n) send_msg(8, audio_buf, (uint32_t)(audio_n * sizeof *audio_buf));
      ff_frame(t - last_audio, sample_rate);
    }
    audio_n = 0;
    last_audio = t;
    if (t - last_mem >= 0.1) { // ten times a second, whatever the speed
      last_mem = t;
      send_mem();
      // which title runs (the game, or an applet / the HOME menu in between)
      static uint64_t last_tid = 1;
      uint64_t tid = twincable_title_id ? twincable_title_id() : 0;
      if (tid != last_tid) {
        last_tid = tid;
        send_event("{\"event\":\"title\",\"titleId\":\"%016llX\"}", (unsigned long long)tid);
      }
    }
    if (t - stat_t >= 0.25) { // four times a second: the page measures the real speed with the frame count
      if (pace_frames >= 120) {
        const double f = sample_rate * (double)pace_frames / (double)pace_samples;
        if (fabs(f / fps - 1) < 0.02) pace_fps = f;
      }
      const double real = stat_frames / (t - stat_t) / pace_fps;
      // (ffk / ffHoles: the fast-forward sound's ratio, and how often its queue ran dry – diagnostics)
      send_event("{\"event\":\"stats\",\"fps\":%.1f,\"speed\":%.3f,\"shown\":%llu,\"frame\":%llu,\"ffk\":%.3f,\"ffHoles\":%u}", stat_frames / (t - stat_t), real,
                 (unsigned long long)frames_shown, (unsigned long long)frame, turbo ? ff.k : 1.0, ff.holes);
      static double sfx_told;
      if (sfx && twincable_audio_music_state && t - sfx_told >= 1) { // (the page asked for sound effects: how the core tells music)
        sfx_told = t;
        uint64_t m[8] = {0};
        twincable_audio_music_state(m, 8);
        send_event("{\"event\":\"sfx\",\"voices\":%llu,\"noted\":%llu,\"hits\":%llu,\"misses\":%llu,\"aac\":%llu,\"romfs\":%llu,\"unsure\":%llu,\"muting\":%d}",
                   (unsigned long long)m[0], (unsigned long long)m[1], (unsigned long long)m[2], (unsigned long long)m[3], (unsigned long long)m[4],
                   (unsigned long long)m[5], (unsigned long long)m[6], sfx_muting);
      }
      stat_t = t;
      stat_frames = 0;
    }
    if (sp >= 100.0f) { next = t; continue; } // as fast as it goes
    next += 1.0 / (pace_fps * sp);
    if (next < t - 0.1) next = t; // fell behind (loading): don't race to catch up
    double wait = next - t;
    if (wait > 0.1) wait = 0.1, next = t + 0.1; // (commands are read between frames – never sleep long)
    if (wait > 0) compat_sleep(wait);
  }
  // Not core.unload_game() / deinit(): Azahar's shutdown can crash after the last frame, and there is nothing left to
  // keep – the game wrote its saves to the save folder as it made them.
  fflush(stdout);
  _exit(0);
}
