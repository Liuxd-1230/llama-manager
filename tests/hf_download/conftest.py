"""pytest 全局配置：在导入 huggingface_hub 前设置环境变量。"""

import os
import sys
from pathlib import Path

# 关闭 Xet（镜像不代理 xet 存储，且保证走可续传的普通 HTTP）
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
