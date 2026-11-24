// The few OS calls ctrhost.c needs, for macOS / Linux (POSIX) and Windows (MinGW-w64 or clang). Everything else in the
// host is plain C and the libretro / Vulkan APIs.
#ifndef CTRHOST_COMPAT_H
#define CTRHOST_COMPAT_H

#include <stdint.h>
#include <stdio.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <process.h>
#include <stdlib.h>
#include <string.h>

// libraries
#define RTLD_NOW 0
#define RTLD_LOCAL 0
static char compat_dlerr[256];
/** UTF-8 → UTF-16 (a new string, or NULL). */
static wchar_t *compat_wide(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
  wchar_t *w = n > 0 ? malloc((size_t)n * sizeof *w) : NULL;
  if (w && !MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n)) {
    free(w);
    w = NULL;
  }
  return w;
}
static void *dlopen(const char *path, int flags) {
  (void)flags;
  // paths are UTF-8 (compat_utf8_argv): the install folder may hold letters the ANSI code page hasn't
  wchar_t *w = compat_wide(path);
  if (!w) {
    snprintf(compat_dlerr, sizeof compat_dlerr, "invalid path");
    return NULL;
  }
  // a full path: the core's own DLLs (none today) are looked up next to it, then on the system path (the altered
  // search order is only defined for absolute paths – "vulkan-1.dll" takes the normal one)
  const int absolute = (w[0] && w[1] == L':') || w[0] == L'\\' || w[0] == L'/';
  HMODULE m = absolute ? LoadLibraryExW(w, NULL, LOAD_WITH_ALTERED_SEARCH_PATH) : NULL;
  if (!m) m = LoadLibraryW(w);
  if (!m) snprintf(compat_dlerr, sizeof compat_dlerr, "LoadLibrary failed (error %lu)", (unsigned long)GetLastError());
  free(w);
  return (void *)m;
}
static void *dlsym(void *lib, const char *name) { return (void *)(uintptr_t)GetProcAddress((HMODULE)lib, name); }
/**
 * fopen for the UTF-8 paths compat_utf8_argv gives: msvcrt's fopen reads a path in the ANSI code page, so the game
 * "Phitty - Blattgrüne Edition.gba" or a user folder like "Jürgen" read as "game not readable" (the fast player then
 * fell back to the web one). _wfopen takes it as UTF-16.
 */
static FILE *compat_fopen(const char *path, const char *mode) {
  wchar_t *w = compat_wide(path);
  wchar_t *m = compat_wide(mode);
  FILE *f = w && m ? _wfopen(w, m) : NULL;
  free(w);
  free(m);
  return f;
}
/** The file a loaded function comes from (which vulkan-1.dll the system really gave us). */
static void compat_lib_path(const void *fn, char *out, size_t cap) {
  HMODULE mod = NULL;
  out[0] = 0;
  if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCSTR)fn, &mod) && mod)
    GetModuleFileNameA(mod, out, (DWORD)cap);
}
static const char *dlerror(void) { return compat_dlerr; }

// locks and the command reader thread
typedef SRWLOCK pthread_mutex_t;
#define PTHREAD_MUTEX_INITIALIZER SRWLOCK_INIT
static int pthread_mutex_lock(pthread_mutex_t *m) { AcquireSRWLockExclusive(m); return 0; }
static int pthread_mutex_unlock(pthread_mutex_t *m) { ReleaseSRWLockExclusive(m); return 0; }
typedef HANDLE pthread_t;
typedef struct { void *(*fn)(void *); void *arg; } compat_thread_start;
static unsigned __stdcall compat_thread_main(void *p) {
  compat_thread_start s = *(compat_thread_start *)p;
  free(p);
  s.fn(s.arg);
  return 0;
}
static int pthread_create(pthread_t *t, void *attr, void *(*fn)(void *), void *arg) {
  (void)attr;
  compat_thread_start *s = malloc(sizeof *s);
  if (!s) return -1;
  s->fn = fn;
  s->arg = arg;
  *t = (HANDLE)_beginthreadex(NULL, 0, compat_thread_main, s, 0, NULL);
  return *t ? 0 : -1;
}

static int compat_trylock(pthread_mutex_t *m) { return TryAcquireSRWLockExclusive(m) ? 1 : 0; }

// Crash reports: what went wrong and in which DLL (the graphics driver, the core, the host) – written to stderr, which
// twincable keeps for "Save diagnostics". No Windows error dialog: it would keep the dead process (and the game's window
// in twincable) waiting for a click nobody sees.
#include <signal.h>
static void (*compat_crash_cb)(const char *what);
static const char *compat_exception_name(DWORD code) {
  switch (code) {
  case EXCEPTION_ACCESS_VIOLATION: return "access violation";
  case EXCEPTION_ILLEGAL_INSTRUCTION: return "illegal instruction";
  case EXCEPTION_STACK_OVERFLOW: return "stack overflow";
  case EXCEPTION_INT_DIVIDE_BY_ZERO: return "division by zero";
  case EXCEPTION_IN_PAGE_ERROR: return "in-page error";
  case 0xE06D7363: return "C++ exception";
  default: return "exception";
  }
}
/** "module+0xoffset" for a code address (the DLL's file name only). */
static void compat_where(const void *addr, char *out, size_t cap) {
  char path[MAX_PATH] = "?";
  HMODULE mod = NULL;
  if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCSTR)addr, &mod) && mod)
    GetModuleFileNameA(mod, path, sizeof path);
  const char *base = strrchr(path, '\\');
  base = base ? base + 1 : path;
  snprintf(out, cap, "%s+0x%llx", base, (unsigned long long)((uintptr_t)addr - (uintptr_t)mod));
}
#if defined(__x86_64__) || defined(_M_X64)
/**
 * The crashing thread's callers (x64 unwind data – every DLL has it, no symbols needed): which function of the core
 * called into the driver. A few frames, "a < b < c", innermost first.
 */
static void compat_stack(const CONTEXT *start, char *out, size_t cap) {
  CONTEXT ctx = *start;
  size_t o = 0;
  out[0] = 0;
  for (int i = 0; i < 8 && ctx.Rip && o + 80 < cap; i++) {
    char w[MAX_PATH + 24];
    compat_where((const void *)(uintptr_t)ctx.Rip, w, sizeof w);
    o += (size_t)snprintf(out + o, cap - o, "%s%s", i ? " < " : "", w);
    DWORD64 image = 0;
    PRUNTIME_FUNCTION fn = RtlLookupFunctionEntry(ctx.Rip, &image, NULL);
    if (fn) {
      PVOID handler_data = NULL;
      DWORD64 frame = 0;
      RtlVirtualUnwind(UNW_FLAG_NHANDLER, image, ctx.Rip, fn, &ctx, &handler_data, &frame, NULL);
    } else { // a leaf function: the return address is on top of the stack
      if (!ctx.Rsp || IsBadReadPtr((const void *)(uintptr_t)ctx.Rsp, 8)) break;
      ctx.Rip = *(const DWORD64 *)(uintptr_t)ctx.Rsp;
      ctx.Rsp += 8;
    }
  }
}
#endif
static LONG WINAPI compat_seh(EXCEPTION_POINTERS *e) {
  char what[900], where[MAX_PATH + 24], stack[600] = "";
  void *addr = e->ExceptionRecord->ExceptionAddress;
  DWORD code = e->ExceptionRecord->ExceptionCode;
  compat_where(addr, where, sizeof where);
#if defined(__x86_64__) || defined(_M_X64)
  if (e->ContextRecord) compat_stack(e->ContextRecord, stack, sizeof stack);
#endif
  if (code == EXCEPTION_ACCESS_VIOLATION && e->ExceptionRecord->NumberParameters >= 2)
    snprintf(what, sizeof what, "%s 0x%08lX in %s (%s address 0x%llx)%s%s", compat_exception_name(code), (unsigned long)code, where,
             e->ExceptionRecord->ExceptionInformation[0] == 1 ? "writing" : e->ExceptionRecord->ExceptionInformation[0] == 8 ? "executing" : "reading",
             (unsigned long long)e->ExceptionRecord->ExceptionInformation[1], *stack ? ", stack " : "", stack);
  else
    snprintf(what, sizeof what, "%s 0x%08lX in %s%s%s", compat_exception_name(code), (unsigned long)code, where, *stack ? ", stack " : "", stack);
  if (compat_crash_cb) compat_crash_cb(what);
  return EXCEPTION_CONTINUE_SEARCH;
}
static void compat_on_abort(int sig) {
  (void)sig;
  if (compat_crash_cb) compat_crash_cb("abort (an uncaught error in the core or the driver)");
  _exit(3);
}
static void compat_crash_handler(void (*cb)(const char *what)) {
  compat_crash_cb = cb;
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  SetUnhandledExceptionFilter(compat_seh);
  signal(SIGABRT, compat_on_abort); // (msvcrt's abort() raises SIGABRT first)
}

// the protocol runs over stdin / stdout: binary, unbuffered
typedef long long compat_ssize;
static compat_ssize compat_read(int fd, void *b, size_t n) { return _read(fd, b, (unsigned)(n > 0x40000000 ? 0x40000000 : n)); }
static compat_ssize compat_write(int fd, const void *b, size_t n) { return _write(fd, b, (unsigned)(n > 0x40000000 ? 0x40000000 : n)); }
static void compat_init(void) {
  _setmode(0, _O_BINARY);
  _setmode(1, _O_BINARY);
  // 1 ms timer resolution: frame pacing at 60 fps needs sleeps shorter than the default 15.6 ms tick
  typedef UINT(WINAPI * tbp)(UINT);
  HMODULE winmm = LoadLibraryA("winmm.dll");
  tbp begin = winmm ? (tbp)(uintptr_t)GetProcAddress(winmm, "timeBeginPeriod") : NULL;
  if (begin) begin(1);
}

// The arguments as UTF-8: libretro cores take UTF-8 paths (Azahar opens them as such), main()'s argv is in the ANSI
// code page – a user name like "Jürgen" (or any letter that code page lacks) broke the ROM / save / system paths.
static char **compat_utf8_argv(int *argc, char **argv) {
  typedef LPWSTR *(WINAPI * c2a_t)(LPCWSTR, int *);
  HMODULE sh = LoadLibraryA("shell32.dll");
  c2a_t c2a = sh ? (c2a_t)(uintptr_t)GetProcAddress(sh, "CommandLineToArgvW") : NULL;
  int n = 0;
  LPWSTR *w = c2a ? c2a(GetCommandLineW(), &n) : NULL;
  if (!w || n < 1) return argv;
  char **out = calloc((size_t)n + 1, sizeof *out);
  if (!out) return argv;
  for (int i = 0; i < n; i++) {
    int len = WideCharToMultiByte(CP_UTF8, 0, w[i], -1, NULL, 0, NULL, NULL);
    out[i] = len > 0 ? malloc((size_t)len) : NULL;
    if (!out[i] || !WideCharToMultiByte(CP_UTF8, 0, w[i], -1, out[i], len, NULL, NULL)) return argv;
  }
  *argc = n;
  return out;
}

// The committed read-write memory at `p` (one region of the address space: same state and protection), or 0.
static inline int compat_rw_region(uintptr_t p, uintptr_t *start, uintptr_t *end) {
  MEMORY_BASIC_INFORMATION m;
  if (!VirtualQuery((const void *)p, &m, sizeof m) || m.State != MEM_COMMIT || (m.Protect & (PAGE_GUARD | PAGE_NOACCESS))) return 0;
  if (!(m.Protect & (PAGE_READWRITE | PAGE_EXECUTE_READWRITE))) return 0;
  // VirtualQuery's region begins at p's own page, not where the pages with these attributes begin (as on macOS and
  // Linux): that start is found by walking the allocation's regions from its base (2.7.2 searched only upwards here)
  uintptr_t s = (uintptr_t)m.BaseAddress;
  for (uintptr_t a = (uintptr_t)m.AllocationBase; a && a < s;) {
    MEMORY_BASIC_INFORMATION r;
    if (!VirtualQuery((const void *)a, &r, sizeof r) || !r.RegionSize) break;
    if (a + r.RegionSize > s) { // the region that holds p's page – it begins here
      s = a;
      break;
    }
    a += r.RegionSize;
  }
  *start = s;
  *end = (uintptr_t)m.BaseAddress + m.RegionSize;
  return 1;
}

// time
static double compat_now(void) {
  static LARGE_INTEGER freq;
  LARGE_INTEGER c;
  if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart / (double)freq.QuadPart;
}
static void compat_sleep(double s) {
  if (s <= 0) return;
  double until = compat_now() + s;
  // sleep most of it, spin the last bit (Sleep's granularity is ~1 ms even with timeBeginPeriod)
  if (s > 0.002) Sleep((DWORD)((s - 0.0015) * 1000));
  while (compat_now() < until) SwitchToThread();
}

#else // POSIX
#include <dlfcn.h>
#include <pthread.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach/mach.h>
#include <mach/mach_vm.h>
#endif

// The read-write memory at `p` (one region of the address space: same protection), or 0. macOS asks the kernel
// (mach_vm_region); Linux reads /proc/self/maps.
static inline int compat_rw_region(uintptr_t p, uintptr_t *start, uintptr_t *end) {
#ifdef __APPLE__
  mach_vm_address_t a = p;
  mach_vm_size_t size = 0;
  vm_region_basic_info_data_64_t info;
  mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64;
  mach_port_t object = MACH_PORT_NULL;
  if (mach_vm_region(mach_task_self(), &a, &size, VM_REGION_BASIC_INFO_64, (vm_region_info_t)&info, &count, &object) != KERN_SUCCESS) return 0;
  if (object != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), object);
  if (a > p || (info.protection & (VM_PROT_READ | VM_PROT_WRITE)) != (VM_PROT_READ | VM_PROT_WRITE)) return 0;
  *start = (uintptr_t)a;
  *end = (uintptr_t)(a + size);
  return 1;
#else
  FILE *f = fopen("/proc/self/maps", "r");
  if (!f) return 0;
  char line[512];
  int found = 0;
  while (fgets(line, sizeof line, f)) {
    unsigned long long s, e;
    char perms[8] = "";
    if (sscanf(line, "%llx-%llx %7s", &s, &e, perms) != 3) continue;
    if (p >= s && p < e) {
      if (perms[0] == 'r' && perms[1] == 'w') {
        *start = (uintptr_t)s;
        *end = (uintptr_t)e;
        found = 1;
      }
      break;
    }
  }
  fclose(f);
  return found;
#endif
}

#include <signal.h>
static int compat_trylock(pthread_mutex_t *m) { return pthread_mutex_trylock(m) == 0; }
// Crash reports (see the Windows part): the signal, written to stderr, then the default action.
static void (*compat_crash_cb)(const char *what);
static void compat_on_signal(int sig) {
  const char *what = sig == SIGSEGV ? "segmentation fault (SIGSEGV)" : sig == SIGBUS ? "bus error (SIGBUS)"
    : sig == SIGILL ? "illegal instruction (SIGILL)" : sig == SIGFPE ? "arithmetic error (SIGFPE)" : "abort (SIGABRT)";
  signal(sig, SIG_DFL);
  if (compat_crash_cb) compat_crash_cb(what);
  raise(sig);
}
static void compat_crash_handler(void (*cb)(const char *what)) {
  compat_crash_cb = cb;
  const int sigs[] = {SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT};
  for (unsigned i = 0; i < sizeof sigs / sizeof *sigs; i++) signal(sigs[i], compat_on_signal);
}
// (dladdr / Dl_info: glibc declares them only with _GNU_SOURCE, which ctrhost.c defines first – retrohost.c, which
// doesn't need this, gets an empty answer instead of a build error on Linux)
#if defined(__APPLE__) || defined(_GNU_SOURCE)
static void compat_lib_path(const void *fn, char *out, size_t cap) {
  Dl_info info;
  out[0] = 0;
  if (dladdr(fn, &info) && info.dli_fname) snprintf(out, cap, "%s", info.dli_fname);
}
#else
static void compat_lib_path(const void *fn, char *out, size_t cap) {
  (void)fn;
  if (cap) out[0] = 0;
}
#endif
typedef ssize_t compat_ssize;
static compat_ssize compat_read(int fd, void *b, size_t n) { return read(fd, b, n); }
static compat_ssize compat_write(int fd, const void *b, size_t n) { return write(fd, b, n); }
static void compat_init(void) {}
static char **compat_utf8_argv(int *argc, char **argv) { (void)argc; return argv; } // already bytes as given
static FILE *compat_fopen(const char *path, const char *mode) { return fopen(path, mode); }
static double compat_now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + t.tv_nsec / 1e9;
}
static void compat_sleep(double s) {
  if (s > 0) usleep((useconds_t)(s * 1e6));
}
#endif

#endif
