// Service views now run with contextIsolation:true + sandbox:true, so a preload
// running in the isolated world can no longer patch the page's Badging API.
// Badge detection moved to a MAIN-world hook injected from main.js (BADGE_HOOK_JS)
// and polled there, so this preload intentionally does nothing. It is kept as the
// configured `preload` entry point (and a place to hang future isolated-world
// bridges); remove the `preload:` option in createServiceView if it stays empty.
