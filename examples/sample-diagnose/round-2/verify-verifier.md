# 取证（第 2 轮，MOCK）

- H1: [CONFIRMED] src/data/loader.py:88 read() 无超时，hang 栈一致
- H2: [REFUTED] src/train.py:140 barrier 配对完整
- 结论：[CONFIRMED] src/data/loader.py:88 read() 无超时导致 worker 阻塞

## 命令
- bash scripts/repro.sh -> exit 0
