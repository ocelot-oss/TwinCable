# Azahar (Nintendo 3DS) – how twincable talks to it

Researched 2026-11-11 against github.com/azahar-emu/azahar (release 2126.2 and master). Code: `server/lib/azahar.mjs`,
`shared/ctr.mjs`, `shared/live/gen67.mjs`.

- **RPC server** (`src/core/rpc/`): UDP port 45987, off by default (`[Debugging] enable_rpc_server` in qt-config.ini,
  Settings › Debug). Packets: 16-byte header { u32 version = 2, id, type, size } + ≤ 32 KiB, little-endian. 2126.2 has
  ReadMemory 1, WriteMemory 2, ProcessList 3, SetGetProcess 4, TakeScreenshot 5, ReadScreenshot 6, GetPerfStats 7;
  master (2127) adds SetFreeCam 8, SaveState 9, LoadState 10, SetInput 11. Version-1 clients (old Citra scripts) get
  no answer.
- **It binds 0.0.0.0** (`udp::endpoint(udp::v4(), 45987)`): reachable from the LAN while Azahar runs, read and write.
  twincable switches it on only after saying so (play view), never silently.
- **Reads are not synchronised with emulation** unless built with ENABLE_SCRIPTING_SYNC – the PK6/PK7 checksum and the
  "shrink only after two reads" rule in gen67.mjs cover torn reads. Without a selected process reads go to the
  current one; twincable selects the game's (process list → title ID 00040000…, or 0 for `.3dsx` homebrew).
- **The RPC server only runs while a game runs** (System::Load) – Azahar open without a game doesn't answer.
- **macOS UDP**: datagrams > 9216 bytes need bigger socket buffers; Azahar 2126.2 raises its own (EnsureBufferSize),
  twincable's client raises its receive buffer.
- **Settings folder**: portable `user/` next to azahar.exe (Windows) or next to Azahar.app (macOS – LaunchQtFrontend
  makes the .app's folder the working directory, then SetUserPath looks for ./user); otherwise
  %APPDATA%\Azahar, ~/Library/Application Support/Azahar (or the XDG folders if an older setup made them),
  $XDG_CONFIG_HOME/azahar-emu (Flathub: ~/.var/app/org.azahar_emu.Azahar). No command-line option for it.
- **macOS `open -a`** with Azahar already running only activates it – the game isn't passed on. twincable refuses a
  second start with a message instead.
- **Files**: Azahar starts .3ds/.cci/.cxi/.3dsx/.app/.elf/.axf and its compressed .zcci/.zcxi/.z3dsx ("Z3DS" header,
  Zstandard); a .cia is installed (File › Install CIA, or `-i` which shows a dialog and exits).
- **Party addresses** (game process): X/Y 0x08CE1CE8 (1.0) / 0x08CE1CF8 (1.5), ORAS 0x08CF727C (1.0) / 0x08CFB26C (1.4),
  Sun/Moon 0x34195E10, Ultra Sun/Moon 0x33F7FA44; six slots 0x1E4 apart, encrypted PK6/PK7 (232 bytes) and the
  encrypted party stats at +0x158. Sources: Citra-Tracker v2 (kcblack42), Pokémon Stream Tool (Readek, Citra memory
  locations), PokeReader (zaksabeast, latest updates). Badges (Gen 6): X/Y 0x08C6A6A0 / 0x08C6A6B0, ORAS 0x08C6DDD4 /
  0x08C71DC4 – each update moves party and badges by the same distance.
- **Wild opponent** (not used yet): X/Y 0x081FF744, ORAS 0x081FFA6C, SM 0x3002F7B8, USUM 0x3002F9A0 (PokeReader) – a
  start for a 3DS battle panel.

## The libretro core in twincable's own player

Checked 2026-11-11 with the real US images of Omega Ruby, Y, Sun and Ultra Sun (`native/ctr-host`, `server/lib/ctr.mjs`,
`web/lib/ctrplayer.mjs`).

- **Graphics**: the core wants OpenGL 4.3 or Vulkan; macOS has only GL 4.1, so the host uses Vulkan through MoltenVK
  (the context negotiation interface, `create_device`). The software renderer manages ~20 fps. Frames come through
  `set_image` (SHADER_READ_ONLY layout); the host copies them back and sends BGRA to the page (WebGL swizzles).
- **Memory**: `RETRO_ENVIRONMENT_SET_MEMORY_MAPS` is sent once at load, before the game makes its heaps – the party
  (0x08Cxxxxx in Gen 6, 0x33Fxxxxx/0x3419xxxx in Gen 7) is not in it. The patch exports `twincable_read_memory(addr, out,
  size)` (the current process's memory, page by page through `IsValidVirtualAddress`) and `twincable_title_id()`. The
  host reads up to 16 regions of 64 KB every 6 frames; `__emu.watch()` adds regions for research (heap scans).
- **New 3DS mode** (`citra_is_new_3ds`, the default) – Old 3DS mode works too, but states don't cross: loading an
  Old 3DS state in New 3DS mode hits a memory assertion and ends the core.
- **Touch**: the pointer device in ±0x7fff over the whole picture (both screens); the core ignores taps shorter than
  a few frames, so the host holds a touch for at least 8 frames. `citra_enable_touch_pointer_timeout` keeps the
  cursor hidden.
- **Gen 7 walks only with the Circle Pad** – the D-pad does nothing on the field, so the page feeds the direction keys
  into the left stick too.
- **Shutdown**: `retro_unload_game` / `retro_deinit` crash (threads still running) – the host ends with `_exit(0)`;
  the games' saves are already on the virtual SD card (`saves/<run>/Azahar/sdmc/…/title/…/data/`), which is also what
  the "saved in the game" indicator watches.
- **Zones** (place sign): Gen 6 keeps the current zone at a fixed address (X/Y 0x081828EC, ORAS 0x08187BD4 –
  PKMN-NTR's `mapidoff`); the ROM's zone table turns it into a met-location ID (pk3DS: XY/ORAS 56 bytes per zone, the
  place at +0x1C, 9 bits; SM/USUM `a/0/7/7` file 0, LZ11, 0x54 bytes, u32 at +0x1C). Gen 7 (found by twincable with
  heap scans through `__emu.watch` across house → outside → house): the player's position { u16, u16 zone, f32 x, y, z }
  – Ultra Sun 0x33F6D74A (a copy of the previous position 0x48 after it), Sun 0x34183CC6; fixed addresses (the same
  after a fresh start). The bytes before the party in RAM are not the save file's layout (no Situation block).
- **Gen 7 battles**: the battlers are 816 bytes from 0x30002770, the player's 12 first, the opponents' after them
  (block 12+, slot ≥ 12). In-battle flag USUM 0x33FC1F65 (Stream Tool) – right; its trainer byte 0x340178B9 reads 1 in
  wild battles too on 1.0. The battle type sits 0x21 before the in-battle flag (USUM 0x33FC1F44): 1 from a trainer's
  cutscene on, 0 for a wild battle. The battle memory is cleared when a battle ends.
- **Azahar 2127.0-rc2** for macOS doesn't start (libavdevice missing from the bundle) – 2126.2 is the tag to build.

## Audit 2026-11-14 (Windows install, AMD crash, layouts)

- **Azahar's Windows zip** (azahar-windows-msvc-2126.2.zip, made with PowerShell) uses backslashes and starts with the
  folder entry `azahar-windows-msvc-2126.2\plugins\` – a reader that only treats a trailing "/" as a folder writes it as
  an empty file, and every `plugins\…\*.dll` after it fails with ENOTDIR (server/lib/archive.mjs `isFolderEntry`).
  macOS (azahar-macos-universal, ditto) and Linux (azahar.AppImage, no unpacking) were fine.
- **The core's libretro device** (libretro_vk.cpp `CreateVulkanDevice`) enables only swapchain, image format list,
  stencil export, external host memory, tooling info, portability subset and custom border colours; vk_instance.cpp then
  still turns on timeline semaphores, extended dynamic state, uint8 indices, fragment shader interlock / barycentrics and
  pipeline cache control when the GPU *offers* them (HAVE_LIBRETRO skips creating the device, not the detection) –
  undefined behaviour on a device that never enabled them. ctrhost hides those extensions from the core's
  vkEnumerateDeviceExtensionProperties (`core_gipa`, CTRHOST_ALL_EXTENSIONS=1 to compare); the renderer takes its
  fallbacks. Same picture and speed on MoltenVK. (2.7.0; since then that is the renderer mode "compat".)
- **Renderer modes** (after 2.7.0, ctrhost `--renderer`, server/lib/ctrrenderer.mjs): "vulkan" gives the core the
  device the standalone Azahar creates – ctrhost answers the core's `vkGetInstanceProcAddr("vkCreateDevice")` with
  `wrap_create_device`, which adds the optional extensions vk_instance.cpp would use (same blacklists by driver ID) with
  their feature structs, and robustBufferAccess. Both apps stay at Vulkan 1.1 (vk_platform.h `TargetVulkanApiVersion`,
  the core's `GetVulkanApplicationInfo`) – a newer API version is not what standalone does. "compat" is the 2.7.0
  hide-path, "software" the core's software renderer (`citra_graphics_api` "Software": no SET_HW_RENDER, XRGB8888
  frames through video_refresh with a pitch; ~25–30 fps on an M1). "auto" steps down within the session when the host
  ends badly in its first 30 s and remembers the step per GPU + driver string (config `ctrRendererMemo`).
- **AMD RX 9070 XT crash** (amdvlk64.dll+0x2e52fc4, driver 2.0.416 / 26.11.1, "running the first frames", also with
  the extensions hidden): azahar-emu/azahar#2742 – the official libretro core crashes the same way in RetroArch on
  that card since 2126.1 (2126.0 fine, standalone fine, OpenGL fine). A ProcDump there put it in `vkCreateImage`;
  PR #2745's workaround hands the driver a copy of the VkImageCreateInfo with the queue-family fields cleared for
  exclusive images (VMA's vkCreateImage callback) and fixed it on that card. ctrhost does the same at the dispatch
  level (`wrap_create_image`: the core's dispatcher and VMA look vkCreateImage up through `core_gipa` / `core_gdpa` –
  `core_gdpa` must also answer "vkGetDeviceProcAddr" with itself, vulkan-hpp re-fetches it through the device). On
  MoltenVK the fields are always 0 (all Azahar create sites zero-initialise them), so why the copy helps on AMD is
  not understood yet; ctrhost logs when it really clears something and names the image in flight on a crash. Azahar's
  2126.1 also made the texture cache recycle/destroy surfaces by GPU tick (rasterizer_cache.h, `GetResourceFreeTick`;
  the libretro core's own MasterSemaphoreLibRetro) – ~3500 images are created in Sun's first 4000 frames – a second
  suspect if the image workaround doesn't hold. Windows crash lines carry an unwind stack (`compat_stack`).
- **Layouts**: the core keeps `citra_layout_option` "default" (400×480, bottom screen at x 40); the page cuts the two
  screens out of that picture and arranges them (shared/ctrlayout.mjs) – no core option change, no restart, touch mapped
  back through the same rectangles.
- **Diagnostics**: ctrhost logs the Vulkan loader file, every device (type, vendor:device, driver), the chosen one and
  the renderer's own info lines, sends an event "gpu" before the core touches the device, and on a crash writes
  "crashed: <exception / signal> in <module>+<offset> while <stage>" to stderr. The server keeps the start and the end
  of stderr, the exit (NTSTATUS names) and the GPU for "Save diagnostics" and in logs/players.log.
