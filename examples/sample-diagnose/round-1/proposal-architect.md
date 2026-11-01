# 排查记录（第 1 轮，MOCK）

## 现象
- 训练脚本偶发 hang，进程不退出，GPU 利用率归零

## 复现
- `bash scripts/repro.sh` 10 次出现 1 次

## 假设
- H1 数据加载线程未设置超时 | 判据：hang 时 loader 栈停在 read() | 待验证
- H2 分布式 barrier 未配对 | 判据：hang 时 rank0 停在 barrier | 待验证

## 根因
- 待定

## 修复建议
- 给 read() 增加超时并 fail-fast
