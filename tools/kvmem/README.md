# KVMem Bonsai MTP 合并脚本

`bonsai-mtp-graft-heretic.py` 是 KVMem prism.3 官方 `bonsai-mtp-graft.py` 的白名单增强版:
base SHA 校验从单一官方模型扩展为白名单(官方 PTQ1_0 + OS-Software Heretic PTQ1_0),
其余逻辑(851 张量逐字节校验、MTP 15 张量映射到 blk.64、Q4_0/Q8_0 量化、审计 JSON)与官方一致。

用法(依赖 numpy + 源码树自带的 llama.cpp/gguf-py,无需 PyTorch/CUDA):

```bash
python bonsai-mtp-graft-heretic.py \
  --base  <Heretic-PTQ1_0.gguf 或官方 PTQ1_0.gguf> \
  --head  model_mtp.safetensors \
  --output <输出-MTP-r3-Q4_0.gguf> \
  --head-type Q4_0
```

产出后用 KVMem 引擎档案启动,勾选 MTP(草稿数 2),服务端旗标由
llama-manager 自动拼装(--spec-type draft-mtp --spec-kv-dtype f16 --kvmem-mtp-state snapshots)。
换新版 Heretic 时:先算 SHA256,把新哈希加进 BASE_SHA_LABELS 白名单即可。
