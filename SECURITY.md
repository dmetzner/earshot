# Security

## Reporting a vulnerability

Please report security issues privately by email to
**[contact@metzner.uk](mailto:contact@metzner.uk)** with "earshot security" in the
subject. Do not open a public issue for them.

Only `main` gets fixes. There are no releases or auto-updates: you build the app
yourself with `build.sh` / `build.ps1`.

## Scope

Earshot holds logged-in sessions for every chat service you add, so the things most
worth reporting are:

- a way for a page to load, or navigate a service view to, content from a host
  outside that service (the navigation gate is `classifyNav` in `nav.js`);
- a way for a service page, or any local process via an `earshot://` link, to reach
  the app's own IPC, the file system, or `shell.openExternal` with a non-http(s) URL.
