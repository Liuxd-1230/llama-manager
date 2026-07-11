"""Environment loading and legacy secret migration helpers."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

from dotenv import dotenv_values, load_dotenv, set_key


APP_DATA_DIR = Path.home() / "llama-manager"
USER_ENV_PATH = APP_DATA_DIR / ".env"


def load_user_env() -> None:
    """Load user-scoped defaults without overriding process environment."""
    if USER_ENV_PATH.exists():
        try:
            load_dotenv(USER_ENV_PATH, override=False)
        except OSError:
            # A stale or externally managed ACL must not prevent startup.
            pass


def env_value(name: str) -> str:
    return os.getenv(name, "").strip()


def env_source(name: str) -> str:
    if not env_value(name):
        return ""
    try:
        file_values = dotenv_values(USER_ENV_PATH) if USER_ENV_PATH.exists() else {}
    except OSError:
        return "process"
    if name in file_values and str(file_values.get(name) or "").strip() == env_value(name):
        return "user_env"
    return "process"


def _restrict_windows_acl(path: Path) -> None:
    if os.name != "nt":
        path.chmod(0o600)
        return
    username = os.getenv("USERNAME", "").strip()
    if not username:
        return
    domain = os.getenv("USERDOMAIN", "").strip()
    identity = f"{domain}\\{username}" if domain else username
    completed = subprocess.run(
        ["icacls", str(path), "/inheritance:r", "/grant:r", f"{identity}:(F)"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if completed.returncode != 0:
        raise OSError("Could not restrict the user environment file ACL")


def set_user_env(name: str, value: str) -> None:
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not USER_ENV_PATH.exists():
        USER_ENV_PATH.touch()
    set_key(str(USER_ENV_PATH), name, value, quote_mode="always")
    _restrict_windows_acl(USER_ENV_PATH)
    os.environ.setdefault(name, value)


load_user_env()
