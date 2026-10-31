"""Atelier backend package.

Importing this package guarantees that loopback traffic (managed engine,
ComfyUI, MCP servers, test fixtures) never routes through a system proxy:
urllib reads the Windows registry proxy (e.g. a local Clash on 127.0.0.1:7890),
and a proxy that is down or refuses loopback would take every local service
call with it.
"""
import os


def _ensure_loopback_bypass() -> None:
    for name in ("NO_PROXY", "no_proxy"):
        entries = [x.strip() for x in os.environ.get(name, "").split(",") if x.strip()]
        changed = False
        for host in ("127.0.0.1", "localhost", "::1"):
            if host not in entries:
                entries.append(host)
                changed = True
        if changed:
            os.environ[name] = ",".join(entries)


_ensure_loopback_bypass()
