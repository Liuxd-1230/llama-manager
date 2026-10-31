"""Single source of the application version; backend/main.py and
moss_server/config.py both read from here so the reported version cannot
drift between entry points."""

APP_VERSION = "3.0.0"
