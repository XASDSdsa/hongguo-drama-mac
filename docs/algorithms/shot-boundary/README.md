# 切镜算法：transnetv2-temporal-min2s-v2

只有这一个版本，没有历史兼容。源码就是 `src/native/video-structure/` 下的 `runner.py`、`shot_verification.py`、`shot_duration.py`，这里不再保存副本。

## 流程

1. TransNet V2 只用 `single` 分数、阈值 0.5 产生候选，每段连续高分取第一个最大峰。`all` 分数不单独触发切割。
2. 用 160×90 全帧做时间结构复核（灰度 64×36、3×3 高斯模糊、亮度归一化、小幅平移匹配、多个时间窗口），排除闪光/特效和片头淡入；不确定的点保留并标 warn。
3. 在复核通过的候选里用动态规划保留累计分数最大的边界集合，每个镜头不少于 2 秒。短镜头只合并，不删帧、不补帧；整片不足 2 秒时整体保留并注明。
4. 按逐帧 PTS 和真实 `video_end` 定位，不按平均帧率换算。

## 切点帧的约定

TransNet V2 标出的是**旧镜头的最后一帧**（官方训练标注里 `one_hot_index = prev_end`，官方 `predictions_to_scenes` 也把这一帧算作旧镜头末尾）。所以输出的每个切点 = 模型帧 + 1，即**下一镜头的第一帧**；分数取模型帧的分数；标在视频最后一帧上的候选没有下一个镜头，直接忽略。

复核在模型帧上做，最短 2 秒按真实切点计算。`decisions[].frame` 是切点帧，`decisions[].model_frame` 是模型标出的帧，结果里带 `boundary_convention: first_frame_of_next_shot`。

## 基线与检查

- `baseline-ep103.json`：《我，万古第一第一季》第 103 集的真实模型分数、PTS 和复核后的模型帧。当前结果 22 个镜头、21 个切点，最短 2.041666 秒，2270 帧完整。
- `python3 scripts/check-shot-algorithm.py`：用基线检查候选、动态规划和切点约定。
- `python3 scripts/check-shot-boundary-convention.py`：用合成帧检查切点是第一帧、2 秒规则和最后一帧忽略。
- 结构复核本身需要原视频的 160×90 帧，基线里没有，所以复核判定靠第二个脚本和端到端实测覆盖。
