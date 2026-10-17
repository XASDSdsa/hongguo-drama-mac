# AI 漫剧生成流程与剪映工程输出方案：完整逻辑版

版本：v2.0｜2026-10-14

这份文件保留用户提供的 v2.0 原文全部内容，并在前面补充程序执行阶段、依赖、状态和任务隔离规则。它不是摘要，也不替换原方案字段。

## 0. 可执行总流程

```text
原视频
  → [建立媒体基准] ffprobe / 必要时固定帧率工作副本
  → [检测镜头边界] PySceneDetect AdaptiveDetector，整数帧、证据和待复核项
  → [落地真实素材] 按统一边界切有声 MP4、抽代表帧、角色/场景参考图
  → [千问第一轮] 整集有声视频 + 镜头代表帧 → styles / characters / scenes
  → [千问第二轮] 固定 shot_id + 有声镜头片段 + 字典 → 动作、对白、声音、提示词
  → [统一 manifest] media / assets / shots / subtitles / audio / generation_tasks / timeline
  → [统一校验] ID、帧覆盖、时间线、文件、提示词段落和下游依赖
  → [并行输出] SRT、HTML 工程图、PNG、剪映四轨草稿
```

四条硬规则：

1. 镜头边界由本地帧检测确定，千问只能描述已确定的镜头，不能替换切点。
2. 工程图和剪映草稿共用同一份 `episode-manifest.json`、`shot_id`、帧边界和 `asset_id`。
3. 源视频切片是“成片参考”，不能冒充 AI 重新生成成功；只有真正执行生成后才写 `generation_tasks.execution`。
4. 项目/季/集/shot 编号放在 UI 和 JSON 元数据，不进入可复制提示词；动作、表情、场景、镜头、对白、声音按 6 秒视频内部连续时间段写入同一条提示词。

## 0.1 阶段状态与门禁

每个项目、剧集、集数、阶段和镜头使用独立 `run_id`、输入指纹、配置快照、输出目录和状态。状态为：`planned → queued → running → succeeded`，失败时为 `failed`，有疑点为 `needs_review`，依赖未完成为 `blocked`。成功只在真实输出通过当前阶段校验后出现；重试创建新 `run_id`，不覆盖其他任务。

| 阶段 | 开始条件 | 成功条件 | 下游门禁 |
| --- | --- | --- | --- |
| 媒体基准 | 原视频可读 | 固定时间基准、帧率、帧数、音轨信息齐全 | 不能确定工作副本 |
| 镜头检测 | 工作副本成功 | 首尾覆盖、无缺口/重叠、异常有记录 | 不能形成合法 shots |
| 真实素材 | shots 合法 | MP4、帧图、参考图存在且帧数匹配 | 不能给千问可靠输入 |
| 千问第一轮 | 有声代理和代表帧存在 | 字典和 shot 引用合法 | 第二轮不能使用空字典 |
| 千问第二轮 | 固定 shot_id、片段、字典存在 | 每个 shot_id 一条详细结果 | 不得写 generation ready |
| manifest | 所有阶段产物存在 | ID、时间、资源引用通过 | HTML/剪映停止 |
| HTML/PNG | manifest 通过 | 模板加载真实资源并导出 | 不能显示随机占位 |
| 剪映草稿 | manifest + 素材通过 | 目标版本打开、播放、保存、重开 | 只能标待验证 |

## 0.2 提示词的唯一写法

同一镜头只保留一份静态描述和一份连续时间线。以 6 秒镜头为例：`0.0–1.5 秒……；1.5–3.8 秒……；3.8–6.0 秒……`，三段是同一个视频内连续发生，不是三个独立镜头。每段同时写清角色/外观、动作/表情/视线、场景和光线、景别/机位/构图/运镜、台词/语气/停顿、环境声/音效/音乐及衔接。时间段必须无空档、无重叠并覆盖完整目标时长。

正文不得出现“素材片段”“反向生成”“从原片提取”等暴露来源表述，也不在上方重复一遍已经写入时间线的动作、场景、镜头段落。角色和场景参考可在工程图/UI 中展示，作为提示词绑定关系。

## 0.3 并发与重试

真实素材抽取按镜头并发，但输出按 `shot.order` 排序；千问逐镜头分析默认每批 4 个镜头，响应截断只缩小批次重试缺失 shot；Demucs 独立运行，不阻塞切片和预览；HTML、PNG、SRT、剪映输出使用同一 manifest，不能互相重新计算时间。任务只写自己的临时目录，通过原子替换正式文件，不能串改其他剧集。

---

## 1. 已整理的完整执行逻辑

本文件把用户提供的《AI 漫剧生成流程推导与剪映工程输出方案 v2.0》整理为程序可以执行的流程。它是实现和验收的逻辑基准。

## 一、最终输入与两类输出

输入是一集中文 AI 漫剧成片。程序同时生成两类结果：

1. **生成流程工程图**：从真实成片推导风格、角色、外观、场景、镜头、动作、对白、声音、参考素材和 Seedance 复现提示词。它是“根据成片推导的方案”，不能宣称恢复了原始模型、原始提示词、种子或抽卡记录。
2. **真实剪映素材与草稿**：从同一份工作视频按同一组镜头边界切出独立 MP4，保留原声，额外提供背景声、SRT 字幕、水印和剪映四轨草稿。

两类结果必须共用一份 `episode-manifest.json`。工程图、镜头预览、视频片段、字幕和剪映草稿都只能引用这份清单中的 `shot_id`、帧边界和 `asset_id`，不能各自重新估计时间或随机抽图。

## 二、流水线和依赖关系

```text
原视频
  ↓
媒体探测与工作副本
  ↓
逐帧镜头检测（AdaptiveDetector）
  ↓
镜头边界清单 + 待确认边界
  ↓
按边界抽帧、参考裁剪、独立有声镜头片段
  ├──────────────┐
  ↓              ↓
千问第一轮：整集资产分析   本地 Demucs：备用背景声
  ↓
角色/外观/场景/风格字典
  ↓
千问第二轮：按 shot_id 逐镜头详细分析
  ↓
字幕、声音事件、动作时间段、复现提示词
  ↓
统一 manifest + 引用/时间/素材校验
  ├──────────────┬─────────────┐
  ↓              ↓             ↓
HTML 工程图       PNG 导出       剪映四轨草稿
```

依赖顺序不能反过来：千问不能决定镜头边界；镜头分析不能在没有固定 `shot_id` 的情况下先写；剪映和 HTML 不能分别生成自己的时间轴。

每个阶段都有独立状态：`planned → queued → running → succeeded`，或 `failed / needs_review / blocked`。失败只记录本阶段原因，不能把空结果标成完成，也不能未经用户选择自动换模型、换接口或换编码器。

## 三、工具职责

| 工具 | 负责内容 |
| --- | --- |
| Qwen-Omni | 读取有声视频，分析画面、对白、声音、角色、场景、风格和镜头内动作；输出结构化分析和复现提示词。 |
| ffprobe | 测量实际宽高、固定帧率、总帧数、音轨、采样率、起始时间、旋转和时长。 |
| FFmpeg | 生成工作副本、抽帧、裁剪参考图、按帧精确切有声 MP4、归零时间戳、提取音频、验证输出。 |
| PySceneDetect AdaptiveDetector | 对工作视频逐帧检测镜头边界，输出整数帧、检测分数和边界证据。 |
| Demucs htdemucs | 整集分离备用背景声；结果可能含环境声、音效和人声残留，不称为无损纯音乐。 |
| Playwright/Chromium | 把 manifest 映射进已有 HTML 模板，并在资源加载完成后导出 PNG。 |
| 剪映草稿工具 | 把真实 MP4、背景声、SRT 和水印排入四类轨道；必须在目标版本完成真实打开、播放、保存、重开验证。 |
| 可选 OCR | 只有需要逐帧贴合画面硬字幕时才启用，不是第一版必装步骤。 |

## 四、媒体基准：所有时间只认工作副本

1. 原视频永远保留，不覆盖。
2. 先用 ffprobe 得到实际媒体信息。视频如果是可变帧率、旋转未应用或起点不是 0，先生成固定帧率、旋转已应用、时间起点为 0 的工作副本。
3. 所有帧号和切片都指向工作副本。原文件帧号和工作副本帧号不能混用。
4. 代理视频可以降低分辨率，但必须保留音画关系，不能变速、删片段或改变镜头边界。
5. `media` 中保存原文件路径、工作文件路径、原文件 SHA-256、工作副本信息、`fps_num/fps_den`、`total_frames`、`duration_us`、音频信息和 `normalized`。

媒体基准由程序测量，不能让模型猜宽高、帧数、帧率、文件路径或时长。

## 五、镜头边界先于内容分析

### 5.1 检测规则

- 默认使用 PySceneDetect `AdaptiveDetector`，起始最短镜头 0.2 秒仅是可调起点，不是精度承诺。
- 真正硬切：新镜头出现的第一帧为边界 `B`；旧镜头不包含 `B`，新镜头从 `B` 开始。
- 闪光、爆炸、快速运镜产生的疑点保留前后预览，必要时交给千问复核或人工确认。
- 底部硬字幕干扰检测时，可以在检测代理中屏蔽字幕区域，但最终素材和分析帧必须使用完整画面。
- 渐变或叠化没有唯一硬切帧，记录过渡区间，采用区间中点并标记 `boundary_kind=transition_midpoint`。
- 黑场、片头、片尾保留，即使没有角色。
- 千问只能指出“片段内疑似还有切镜”的范围；程序只重扫该范围，千问不能覆盖全部已确定边界。

### 5.2 统一区间和换算

所有镜头使用左闭右开区间：`[start_frame, end_frame_exclusive)`。

```text
boundary_us = round(frame_index × fps_den × 1_000_000 / fps_num)
start_us = convert(start_frame)
end_us = convert(end_frame_exclusive)
duration_us = end_us - start_us
frame_count = end_frame_exclusive - start_frame
```

四项硬性检查：第一镜头从 0 帧开始；相邻镜头无间隙、无重叠；最后一镜头结束帧等于总帧数；所有 `frame_count` 之和等于总帧数。

### 5.3 真正切片

按确定帧区间解码并重新编码，视频与音频裁剪后都归零时间戳。不能把任意位置的 `-c copy` 当作精确切片。每个片段生成后检查帧数、尺寸、可播放性、音画同步和实际时长。

## 六、两轮千问分析

### 第一轮：整集资产分析

输入：整集有声分析代理、镜头清单、每个镜头的代表帧或低码率预览。输出：

- `styles`：可执行的画风、线条、材质、色板、光影、人物比例；
- `characters`：稳定角色 ID、可见外观、服装版本、证据帧、参考裁剪需求；
- `scenes`：空间、布局、光线、色彩、地标、证据帧；
- 每个已确定 `shot_id` 对应的角色、外观和场景关系。

这一轮不重新生成切点，也不凭剧情给角色强行命名。无姓名证据时使用“角色 A”等临时显示名；身份有疑点保留 `needs_review`。

### 第二轮：逐镜头详细分析与复现方案

输入：固定的 `shot_id`、全局帧区间和时间、该镜头真实有声片段、代表帧、前后镜头代表帧、第一轮建立的角色/场景/风格字典。默认每批 4 个镜头，可配置。

要求每个 `shot_id` 输出一条且只输出一条分析：

- 出现了谁、谁说话、是否画外音；
- 场景、位置、景别、视角、构图和运镜；
- 起始状态、按时间排序的动作段、结束状态；
- 对白原文、画面硬字幕原文、二者冲突；
- 环境声、音乐、音效和对白特征；
- 角色/场景参考素材需求；
- 可执行的生成提示词和前后镜头连续性要求。

对白跨镜头只生成一条全局字幕，引用多个 `shot_id`，不能每个镜头重复一句话。模型返回截断时，只缩小批次重试缺失镜头，不重复全片调用。

## 七、统一结果文件和对象关系

顶层 `episode-manifest.json` 固定包含：

```text
schema_version
project_id
media
styles[]
characters[]
scenes[]
assets[]
shots[]
subtitle_cues[]
audio_events[]
generation_tasks[]
workflow_nodes[]
workflow_edges[]
timeline
review_items[]
usage
```

空数组使用 `[]`，未知标量使用 `null`。所有 ID 全局唯一，引用必须存在。

### 7.1 styles、characters、scenes

`styles` 包含 `style_id`、`render_type`、`linework`、`material`、`palette`、`lighting`、`character_proportion`、证据帧和可执行 `prompt_fragment`。

`characters` 包含 `character_id`、显示名、姓名证据、脸/发/体态、`appearances[]`、参考素材 ID、证据帧、保持一致的提示词片段和复核状态。服装变化新建 `appearance_id`，不随意新建角色。

`scenes` 包含地点类型、布局、时间（无法确定用 null）、光线、色彩、地标、参考素材 ID、证据帧和提示词片段。不能把暗画面直接断言为午夜。

工程图可以显示角色和场景参考图，让用户知道提示词引用了哪些参考；提示词正文不写“角色预设与参考”这种 UI 标题，也不额外重复一段已经写进镜头时间线的动作描述。

### 7.2 assets

每个真实文件登记 `asset_id`、`kind`、`path`、`origin`、来源帧、归一化裁剪框、引用对象和 `ready/failed` 状态。没有实际文件的计划只能放在任务表，不能填假路径。

至少支持：`character_ref`、`scene_ref`、`shot_preview`、`video_clip`、`background_audio`、`watermark`。参考图必须来自真实无遮挡帧；只有侧脸就标明侧脸，不能假装有三视图。

为避免用户看到重复帧：同一镜头的代表帧按镜头内部时间分布抽取；如果感知哈希重复，换取同一镜头内的其他帧并记录原因。不同镜头不得无标记共享同一图片。

### 7.3 shots

每条镜头至少包括：

```text
shot_id / order
start_frame / end_frame_exclusive / frame_count
start_us / end_us / duration_us
boundary_kind / boundary_status
scene_id / character_ids / appearance_ids
shot_size / camera_angle / composition / camera_movement
start_state / action_beats / end_state
subtitle_ids / audio_event_ids
representative_frame / preview_asset_id / clip_asset_id
continuity / visual_description / uncertainty_codes
```

`action_beats` 的每段包含 `local_start_us`、`local_end_us`、角色、动作、对象、结果状态和 `timing_method`。镜头内部时间绝不能越过本镜头边界。镜头边界来自帧检测；动作和声音内部时间如果是模型估计，必须标记 `model_estimated`，不能伪装成逐帧验证。

### 7.4 subtitle_cues 和 audio_events

字幕字段同时保存 `display_text`、`visual_text`、`spoken_text`、文字来源、冲突、说话人、全局起止时间、时间来源、时间状态、关联镜头和 `visible`。

`subtitle_cues` 是字幕的结构化唯一来源；SRT 只是从它导出的剪映/交付文件，不再另存一份独立转写 JSON/TXT。SRT 和 JSON 同时存在是“数据源 + 交付格式”，不是两套互相竞争的识别结果。

`audio_events` 按 dialogue、narration、music、ambience、sfx 记录全局时间、文本/描述、说话人、时间方法、状态和关联镜头。原声包含对白、环境声和音效；Demucs 背景轨只是备用，默认静音，不能和原声无条件叠加。

## 八、生成任务与提示词

### 8.1 任务组织和时长

第一版默认一个镜头一个复现任务；超过目标模型能力时拆成可衔接任务；特别短的镜头可请求更长结果再裁剪。模型能力从当前配置读取，不硬编码。

`target_duration_us` 是成片需要保留的真实长度；`request_duration_s` 是提交给生成模型的请求时长；`trim_range_us` 是生成结果需要保留的范围。三者不能混用。能力未核对时 `request_duration_s=null`，任务只能导出方案，不能提交生成。

### 8.2 prompt_parts

每个任务必须包含：

```text
subject
environment
composition
action_sequence
camera
dialogue
audio
style
continuity
exclusions
```

项目名、季数、集数、内部 `shot_id`、`01/03` 之类的工程编号只存在于外层 JSON 和 UI，不写进可复制的提示词正文。

提示词正文不再采用“上面静态描述一遍，下面时间线又重复一遍”的写法。静态信息只保留一次；动作、表情、场景变化、镜头运动和声音变化直接按视频内部时间段写入 `action_sequence`。例如 6 秒镜头应写成连续的局部时间：`0.0–1.5 秒……；1.5–3.8 秒……；3.8–6.0 秒……`。这是同一个视频内的时间线，不是三个独立镜头。

时间段必须覆盖 `[0, target_duration_us)`，前后连续、无重叠、无空档。每一段写清楚：

- 角色与服装/外观；
- 动作、表情、视线和结果状态；
- 场景中的位置、前中后景和光线；
- 景别、机位、构图和运动方向/速度；
- 对白逐字内容、语气、停顿；
- 环境声、音效、音乐是否存在；
- 与上一段、下一镜头需要保持的连续性。

提示词中不放“素材片段”“反向生成”“已从原片提取”等暴露来源的表述。源视频切片在工程图中标为“成片参考”，生成任务标为“复现方案/待生成”；未真实调用生成模型时 `execution=null`。

### 8.3 实际生成记录

只有用户真正提交生成后，才写入 `execution`：供应商任务 ID、模型、参数、提交时间、返回状态、候选文件、预览图、选用候选和费用。源视频切片不能冒充生成结果，工程图不能画出虚假的“已生成 → 当前成片”事实连线。

## 九、HTML 工程图和 PNG

沿用已有 HTML 模板，使用同一份 manifest 映射：

| 模板区域 | 数据来源 | 真实图片/状态 |
| --- | --- | --- |
| 风格 | `styles` | 风格证据帧；分析所得 |
| 角色参考 | `characters`、`appearances` | 真实角色裁剪图；已提取 |
| 场景参考 | `scenes` | 真实场景帧；已提取 |
| 分镜卡片 | `shots` | 区间、时长、动作、对白、真实代表帧；已分析/待确认 |
| 视频生成方案 | `generation_tasks` | 参考绑定、时长约束、完整提示词；复现方案/待生成 |
| 成片片段 | `video_clip` assets | 对应镜头真实 MP4；已截取 |
| 剪辑输出 | `timeline` | 真实轨道和草稿状态；已组装/待验证 |

分镜卡片左侧视频下的帧图必须来自该视频对应的镜头区间，并显示其局部秒数；点击后可放大查看。视频使用真实 MP4，支持播放控件和全屏。若帧抽取失败，显示失败原因，不能用其他镜头图片占位。

连线只表达两种关系：

- 方案输入：风格、角色、场景、分镜 → 复现任务；
- 实际素材：成片片段、背景声、字幕、水印 → 剪映编辑。

生成 PNG 前检查图片和字体加载完成，模板中的编号、时长、路径必须来自 manifest，不允许展示层重新生成随机数据。

## 十、剪映四轨

| 轨道 | 内容 | 规则 |
| --- | --- | --- |
| 视频 | 按镜头帧区间切出的 MP4 | 每段素材入点为 0，时间轴位置取 `shot.start_us`，保留原声 |
| 背景声 | Demucs 非人声结果 | 从 0 开始，默认静音；开启后不能与原声重复放大 |
| 字幕 | `subtitle_cues` 导出的 SRT/文字片段 | 使用全局时间；已有硬字幕时默认隐藏或透明 |
| 水印 | 用户 PNG 或文字 | 没有用户素材就不虚构；默认覆盖整集，位置可调 |

没有水印时允许三条实际轨道；不为了占位生成空轨。草稿工具必须用目标剪映版本完成“打开—播放—编辑—保存—退出—重开”小样验证后才算可交付。

## 十一、校验、状态和重新导出

### 11.1 必须阻止的错误

- 帧区间负数、反向、越界、缺口或重复覆盖；
- 片段打不开、帧数或尺寸与计划不符；
- 任何角色、场景、字幕、素材或节点引用不存在的 ID；
- 标记 ready 的资源没有真实文件；
- HTML 和剪映使用不同 manifest；
- 提示词时间段越界、重叠或没有覆盖目标时长；
- 未核对模型能力却写入 `ready_to_run`；
- 未实际生成却填 `execution` 或成功候选。

### 11.2 允许继续但必须标记

角色姓名、说话人、遮挡参考图、字幕时间、过渡中点、模型时长等不确定信息可以继续生成工程图和剪辑草稿，但必须写入 `review_items`，并阻止依赖它的真实生成提交。

### 11.3 修改影响范围

- 改镜头边界：重算相邻边界、时间、缩略图、字幕关联，重切受影响片段并重导 HTML/草稿；背景声无需重分离。
- 改台词：更新字幕和相关提示词并重导，不必重切视频。
- 改角色归属：更新角色引用、参考绑定和提示词，不动镜头边界。
- 改生成模型：重新校验请求时长和参考图限制，不改成片片段时长。

所有阶段保存输入指纹、配置快照和输出路径；输入或配置变化时只让受影响阶段及其下游失效，不能串改正在运行的其他剧集/镜头。

## 十二、并发与任务隔离

- 同一剧集的镜头切片和抽帧可以并发，但输出顺序按 `shot.order` 重新排序。
- 千问按批提交，默认每批 4 个镜头；批次之间共享并发额度，响应截断只重试缺失镜头。
- Demucs 整集任务独立运行，不能阻塞已完成的镜头切片和工程图预览。
- 每个阶段用独立任务 ID、输入指纹、锁和状态文件；任务只能写自己的输出目录。
- 暂停、失败、重试不会把已完成阶段重新标为未完成；重试从最近一个有效检查点继续。
- 进度显示实际阶段、完成数、当前镜头和错误原因，不用固定百分比掩盖无输出或等待。

## 十三、推荐目录

```text
剧集目录/
├── source/
│   └── original.mp4
├── work/
│   ├── normalized.mp4
│   └── proxies/
├── analysis/
│   ├── episode-manifest.json
│   ├── qwen-global.json
│   └── qwen-shots/
├── assets/
│   ├── frames/
│   ├── refs/
│   ├── clips/
│   └── audio/
├── subtitles/
│   └── episode.srt
├── workflow/
│   ├── index.html
│   └──工程图.png
└── jianying/
    └── draft/
```

`episode-manifest.json` 是结构化事实源；`episode.srt` 是由 `subtitle_cues` 导出的交付文件；HTML、PNG、MP4、背景声和草稿都是登记过的输出。不要再额外维护一套未登记的临时 JSON 或手写时间轴。

## 十四、交付和验收顺序

1. 一集样片完成媒体基准、AdaptiveDetector 边界和独立片段，并证明所有片段无缺口、可按边界拼回。
2. 生成代表帧、参考裁剪、Demucs 背景声和 `episode-manifest.json`。
3. 完成千问第一轮和第二轮，核对角色引用、动作段、字幕、声音事件和提示词时间线。
4. 接入已有 HTML 模板，确认每张图和每个视频都对应同一 `shot_id`。
5. 导出 SRT、工程图 PNG 和剪映四轨小样，在目标剪映版本实测重开。
6. 再加入批量剧集、阶段恢复、模型能力检查、成本统计和并发扩展。

交付物包括：完整分析 JSON、复现流程方案、HTML 与 PNG、独立镜头 MP4、参考图和预览图、备用背景声、SRT 和剪映草稿。费用只能按实际 Qwen 输入/输出 Token、调用次数、重试和缓存记录统计，不能用单次样片价格承诺整集成本。

---

## 2. 用户提供的 v2.0 原文（完整保留）

以下原文保留字段详细设计、完整 JSON 示例、千问任务指令、HTML 映射、剪映四轨、校验、交付优先级、费用和参考来源，作为实现验收的逐项依据。


版本：v2.0｜2026-10-14
范围：处理方案、工具、AI 分析输入输出、分镜规则、模板映射。本文不规定后端框架、网络接口和部署架构。

## 1. 最终要做什么

输入一集中文 AI 漫剧成片，同时得到两类成果：

1. **生成流程方案与工程图**：从成片提取角色、场景、风格、镜头、动作、对白和参考素材，推导一套以 Seedance 为目标的音视频生成方案，填写用户已有 HTML 模板，再输出图片。
2. **剪映草稿与真实素材**：实际切出独立镜头视频，保留视频原声，分离背景声音，生成字幕轨，加入用户水印，组装可编辑草稿。

两类成果共用同一组镜头 ID、时间边界和素材，不允许工程图与剪映中的分镜对不上。

推导出的提示词与生成任务是用于复现的方案；源视频原始模型、提示词、种子、抽卡记录不能从成片确认。成片切片可以作为真实“成片片段”展示，不能标成已经通过本工具重新生成成功。实际运行生成后，才记录真实任务 ID、候选结果和选用记录。

## 2. 最推荐的工具组合

| 工具 | 必须完成的任务 | 选择理由 |
| --- | --- | --- |
| 千问 Qwen-Omni 云端 API | 看画面、听声音，输出角色场景、逐镜头描述、对白、生成提示词与参考素材建议 | 中文音视频统一分析，本地不部署大模型 |
| PySceneDetect AdaptiveDetector | 在实际视频帧中检测切镜，输出整数帧边界 | 分镜切割不能靠大模型估计的秒数；无需另外部署大型神经网络 |
| FFmpeg / ffprobe | 视频探测、时间基准整理、独立切片、抽帧、提取音频 | 输出真实素材，确保各成果使用同一时间轴 |
| Demucs htdemucs | 整集背景声分离 | 保留非人声结果作为背景音备用素材 |
| 用户 HTML 模板 + Playwright/Chromium | 填内容、放参考图和分镜图、导出 PNG | 沿用已设计的样式 |
| 已验证版本的剪映草稿工具 | 将真实文件排入四类轨道 | 必须先做目标版本小样，不能只检查 JSON |
| 可选：本地 OCR | 字幕文字出现/消失的逐帧校准 | 只有隐藏字幕也需要贴合原字幕变化时再启用，不作为第一版必装项 |

千问候选型号为 `qwen3.8-omni-flash`，具体账号可用性和输入参数以官方文档为准。以上工具在同一处理入口内工作，不要求用户分别手工操作。

**本版对前版的关键修正：分镜检测是默认步骤。大模型描述已确定的镜头，不能替代镜头边界检测。**

## 3. 镜头、场景、生成任务必须分清

| 对象 | 定义 | 示例 |
| --- | --- | --- |
| 镜头 shot | 实际画面的连续拍摄/生成视角区间，切镜后形成新镜头 | 客厅中景切到人物面部特写，是两个镜头 |
| 场景 scene | 可反复出现的空间及视觉环境 | 两个镜头可以都属于同一个客厅场景 |
| 生成任务 generation_task | 为复现而设计的一次视频生成请求 | 第一版默认一个镜头对应一个待生成任务；可人工合并连续镜头 |
| 剪映片段 clip | 从输入成片真实切出的独立媒体文件 | shot_001 对应 shot_001.mp4 |

不能因对白换了一句就新建镜头，也不能因同一地点出现多个切镜就合为一个视频片段。最终成片无法可靠显示原始生成任务边界，因此生成任务的分组属于方案设计。

## 4. 处理顺序

### 4.1 建立视频基准

先用 ffprobe 获取实测媒体信息：宽、高、帧率、帧数、音频、起始时间、旋转和时长。

- 原文件留存，不覆盖。
- 固定帧率文件可直接作为工作基准。
- 可变帧率文件先转换为固定帧率工作副本；记录转换前后的路径、时长与输出帧率。
- 所有“第几帧”都指向工作副本，不能混用原文件和副本帧号。
- 视频播放起点统一为 0。旋转应用到画面后，角色框、字幕框均按工作画面的宽高计算。
- 分析代理可降低分辨率，但必须保留音频与时间关系；不能变速或另行删除片段。

### 4.2 先找镜头边界，再进行内容分析

对工作视频逐帧执行 AdaptiveDetector，保留检测分数及切点所在帧。推荐起始配置为工具默认阈值、最短镜头 0.2 秒；这是项目的起始参数，需用样片调整，不是通用精度保证。

检测规则：

1. 真正硬切：用新镜头出现的第一帧作为边界 B。
2. 旧镜头区间结束于 B，不包含 B；新镜头从 B 开始，包含 B。
3. 闪光、特效爆炸、快速运镜可能误触发。对短片段和异常分数片段生成切点前后预览，疑点才交给千问复核或人工选帧。
4. 字幕变化可能影响检测。必要时在检测代理中屏蔽底部字幕区域，并保留完整画面用于最终抽帧和分析；不能裁掉原素材。
5. 渐变、叠化本来没有唯一硬切帧：记录过渡区间，选定区间中点帧作为编辑分界，并明确 `boundary_kind=transition_midpoint`。
6. 黑场、片头、片尾仍要保留，不能因为缺少角色就丢弃。
7. 模型若指出片段内还有切镜，返回可疑范围，程序只重扫该范围；模型不能随意覆盖全部已确定边界。

算法输出整数帧，不等于保证识别全对。未解决的边界必须进入待确认列表，不能用“约 3 秒”代替切片参数。

### 4.3 建立角色、场景与风格表

给千问整集有声分析代理，以及各镜头代表帧，建立全局表：

- 角色 ID：人物外观、服装版本、证据帧；无明确姓名就用“角色 A”。
- 场景 ID：地点类型、空间布局、光线和色彩、证据帧。
- 风格 ID：二维/三维表现、线条、材质、色彩、光影、人物比例。

角色衣服变化采用 appearance_id，不直接新建另一个角色；身份不确定则保留待确认，不能强行合并。风格表供各生成任务引用，在 HTML 中按现有模板映射，不擅自增加页面顶部大组件。

### 4.4 按确定镜头逐项分析

向千问提供有声镜头、镜头 ID、全局起止帧/时间、角色和场景字典。可以小批量提交，但必须保留明确的镜头对应关系。

每个镜头必须回答：

- 谁在画面中，谁说话，是否画外音？
- 在什么场景、哪个位置？
- 景别、视角、构图、运镜是什么？
- 开始状态、动作过程、结束状态是什么？
- 对白原文、硬字幕原文分别是什么？
- 原声包含什么背景声和音效？
- 复现镜头需要哪些人物/场景参考图？
- 如何写成可执行的音视频生成提示词？

程序提供的镜头边界固定；模型只能填写内容和片段内事件时间。它不负责捏造帧率、帧数、源文件路径或生成任务 ID。

### 4.5 落地素材并生成成果

按统一帧边界切 MP4、抽代表图和参考裁剪图；整集分离背景声，生成字幕，再填 HTML 并写剪映草稿。生成流程方案中的参考素材与提示词和实际切片分别标识，避免混淆。

## 5. 时间和切片规则：必须能直接执行

### 5.1 统一使用左闭右开区间

镜头区间为 `[start_frame, end_frame_exclusive)`。

以 25 fps、总计 200 帧的 8 秒视频为例：

| 镜头 | 起始帧 | 结束帧（不含） | 实际包含帧 | 时长 | 剪映起点 |
| --- | ---: | ---: | --- | ---: | ---: |
| shot_001 | 0 | 100 | 0～99 | 4 秒 | 0 秒 |
| shot_002 | 100 | 200 | 100～199 | 4 秒 | 4 秒 |

此处 4 秒来自例子的边界，不是默认随机时长。

### 5.2 时间换算

帧率必须保存成分数 `fps_num / fps_den`。每个边界独立换算：

```text
boundary_us = round(frame_index × fps_den × 1_000_000 / fps_num)
start_us = convert(start_frame)
end_us = convert(end_frame_exclusive)
duration_us = end_us - start_us
frame_count = end_frame_exclusive - start_frame
```

展示用毫秒和时间码由程序派生，不能让模型分别填写相互冲突的秒数与帧数。不要先四舍五入每个镜头时长再累计，否则整集可能漂移。

### 5.3 四项硬性校验

- 第一镜头从第 0 帧开始。
- 下一镜头起始帧等于前一镜头结束帧。
- 最后镜头结束帧等于工作视频总帧数。
- 所有镜头 frame_count 之和等于工作视频总帧数。

### 5.4 真正切割

视频按确定帧区间解码、裁剪、归零时间戳、重新编码；音频按对应起止时间裁剪并归零。不能把任意位置的 `-c copy` 当作精确切片。

切完逐个检查视频帧数、画面尺寸及音频同步。音频编码可能有尾部填充，不能拿音频容器时长反过来改变视频镜头边界；草稿片段长度使用统一视频边界。

## 6. 分析结果总结构

结果分为“实测与提取”“AI 分析”“生成方案”三层，统一保存、统一引用。

| 顶层字段 | 类型 | 内容 | 谁产生 |
| --- | --- | --- | --- |
| schema_version | string | 输出格式版本 | 程序 |
| project_id | string | 本次项目 ID | 程序 |
| media | object | 工作视频及时间基准 | ffprobe/程序 |
| styles | array | 风格定义 | 千问 |
| characters | array | 角色与外观版本 | 千问，裁剪由程序完成 |
| scenes | array | 场景定义与参考帧 | 千问 |
| assets | array | 实际存在的图片、视频、音频资源 | 程序登记 |
| shots | array | 确定边界的分镜及逐镜头内容 | 程序 + 千问 |
| subtitle_cues | array | 对白字幕及显示区间 | 千问，按需校准 |
| audio_events | array | 对白/音乐/音效事件 | 千问 |
| generation_tasks | array | Seedance 复现任务与提示词 | 千问提出、程序校验 |
| workflow_nodes | array | HTML 流程节点 | 程序映射 |
| workflow_edges | array | 节点依赖关系 | 程序映射 |
| timeline | object | 剪映四类轨道 | 程序 |
| review_items | array | 有明确对象和原因的待确认项 | 程序/千问 |
| usage | object/null | 分析调用次数、Token、费用 | 实际接口返回 |

数组没有内容用 `[]`，未知标量用 `null`。禁止用“未知”字符串代替数值。每个 ID 全局唯一，所有引用必须存在。

## 7. 字段详细设计

### 7.1 media：工具实测，不交给模型猜

| 字段 | 类型 | 要求 |
| --- | --- | --- |
| original_file | string | 原文件路径 |
| working_file | string | 实际切片的工作文件路径 |
| source_sha256 | string | 原文件内容哈希 |
| width / height | integer | 工作画面像素尺寸 |
| fps_num / fps_den | integer | 固定帧率分数，均大于 0 |
| total_frames | integer | 工作视频解码帧数 |
| duration_us | integer | 统一时间基准的总时长 |
| has_audio | boolean | 是否存在音轨 |
| audio_sample_rate | integer/null | 音频采样率 |
| normalized | boolean | 是否做了时间/旋转/帧率标准化 |

### 7.2 styles：统一生成约束

每条包含 `style_id`、`render_type`、`linework`、`material`、`palette`、`lighting`、`character_proportion`、`evidence_frame_indices`、`prompt_fragment`。

描述必须可执行。例如“二维赛璐璐，细黑轮廓，冷蓝环境光，肤色低饱和，人物比例写实”，不能只写“高级、电影感”。不确定具体制作技术时只描述可见效果。

### 7.3 characters：角色与服装版本

| 字段 | 类型 | 要求 |
| --- | --- | --- |
| character_id | string | 稳定 ID，如 char_001 |
| display_name | string | 有证据用姓名，否则角色 A |
| name_evidence | object/null | 字幕/对白来源及时间，不能按脸猜名字 |
| face / hair / body | string | 可见特征描述，不编画外细节 |
| appearances | array | appearance_id、服装、配饰、所属镜头 |
| reference_asset_ids | string[] | 已提取的角色参考裁剪图 |
| evidence_frame_indices | integer[] | 对应工作视频帧号 |
| prompt_fragment | string | 用于保持身份和服装一致的描述 |
| needs_review | boolean | 身份是否存在疑点 |

角色图优先从无遮挡、清晰的真实帧裁剪。只有侧脸就标记侧脸参考，不声称已拥有三视图；需要新制设定图时新增“待生成素材任务”。

### 7.4 scenes：场景表

每条包含 `scene_id`、`name`、`location_type`、`layout`、`time_of_day`、`lighting`、`palette`、`landmarks`、`reference_asset_ids`、`evidence_frame_indices`、`prompt_fragment`。

`time_of_day` 无法确定用 null；不要根据暗色画面直接断言午夜。场景布局描述可见门窗、人物相对位置和主要物体，避免后续反打镜头方向混乱。

### 7.5 assets：素材来源与可用性

| 字段 | 类型 | 要求 |
| --- | --- | --- |
| asset_id | string | 唯一资源 ID |
| kind | enum | character_ref / scene_ref / shot_preview / video_clip / background_audio / watermark |
| path | string | 实际文件生成完成后登记 |
| origin | enum | source_frame / source_crop / source_clip / separated_audio / user_upload / generated |
| source_frame_index | integer/null | 图像来源帧 |
| crop_xyxy | number[4]/null | 归一化框 [x1,y1,x2,y2]，左上为原点，范围 0～1 |
| used_by_ids | string[] | 角色/场景/镜头/任务的引用 |
| status | enum | ready / failed；未产生文件的计划放在任务表，不填假路径 |

框必须满足 x1 < x2、y1 < y2。模型建议的裁剪框必须用实际图像检查边界和可见区域，不能假设它像素级准确。

### 7.6 shots：每个分镜必须完整填写

| 字段 | 类型 | 要求 |
| --- | --- | --- |
| shot_id / order | string / integer | 稳定 ID 与显示顺序 |
| start_frame / end_frame_exclusive | integer | 程序确定，模型不修改 |
| frame_count / start_us / end_us / duration_us | integer | 程序统一计算 |
| boundary_kind | enum | start / hard_cut / transition_midpoint / manual |
| boundary_status | enum | detected / verified / needs_review |
| scene_id | string/null | 场景引用 |
| character_ids / appearance_ids | string[] | 本镜头出现的角色及服装版本 |
| shot_size | enum | extreme_wide / wide / medium / close_up / extreme_close_up / mixed / unknown |
| camera_angle | enum | eye_level / high / low / overhead / dutch / mixed / unknown |
| composition | string | 人物位置、朝向、前后景关系 |
| camera_movement | array | 类型、时间区间、方向、速度描述；静止也明确记录 |
| start_state | string | 镜头开始的姿态、物件和空间状态 |
| action_beats | array | 按时间排序的动作段 |
| end_state | string | 镜头结束状态，为衔接提供约束 |
| subtitle_ids / audio_event_ids | string[] | 关联字幕与声音事件 |
| representative_frame | integer | 必须落在镜头帧区间内 |
| preview_asset_id / clip_asset_id | string | 实际图像与切片资源引用 |
| continuity | object | 与前后镜头的身份、衣服、视线、道具、位置衔接约束 |
| visual_description | string | 客观描述，供 HTML 分镜卡片展示 |
| uncertainty_codes | string[] | 如 speaker_unknown、occluded_face |

每个 action_beat 包含 `local_start_us`、`local_end_us`、`actor_ids`、`action`、`object`、`result_state`。事件时间限定在本镜头内；镜头局部事件不得越界。

时间属性分两类：**镜头边界由视频帧确定；动作、声音的内部时刻可能来自模型估计，必须保存 timing_method。** 用整数表示时间并不会自动提高识别精度。

### 7.7 subtitle_cues：原文、时间、说话人分开

| 字段 | 类型 | 要求 |
| --- | --- | --- |
| subtitle_id | string | 唯一 ID |
| display_text | string | 实际准备写入字幕轨的文字 |
| visual_text | string/null | 画面中读到的原字幕 |
| spoken_text | string/null | 音频听到的对白 |
| text_source | enum | visual / audio / visual_and_audio / user_corrected |
| text_conflict | boolean | 画面字幕与语音是否有实质差异 |
| speaker_id | string/null | 不确定说话人时为空 |
| start_us / end_us | integer | 全局时间，必须满足 0 <= start < end <= 视频总时长 |
| timing_method | enum | model_estimated / visual_frame_checked / forced_aligned / user_corrected |
| timing_status | enum | estimated / verified / needs_review |
| shot_ids | string[] | 与字幕时间有交集的镜头列表 |
| visible | boolean | 已有硬字幕时默认 false |

镜头精确切割与字幕精确显示是两项任务。第一版隐藏字幕可采用模型时间，不能把它标成逐帧校准结果。需要贴合硬字幕时：在候选时间前后检测字幕区域，逐帧确认文字首次出现和消失边界；该步骤完成后才标 `visual_frame_checked`。对白跨镜头时只保留一条全局字幕，并引用多个镜头，不能重复生成同一句。

### 7.8 audio_events：原声如何写进生成方案

每条包含 `audio_event_id`、`type`（dialogue/narration/music/ambience/sfx）、`start_us`、`end_us`、`speaker_id`、`text`、`description`、`timing_method`、`timing_status`、`shot_ids`。

对白音色描述只写听到的音高、语速、情绪等，不冒充可恢复的原始音色 ID。音乐描述节奏、情绪与可辨乐器，不猜歌曲名称。声音事件表用于生成提示词和检查，并不要求把每个音效都拆成剪映轨。

## 8. generation_tasks：把分析变成生成流程方案

### 8.1 默认任务组织

第一版一个镜头对应一个视频复现任务。若时长超出目标模型限制，拆成多个可衔接任务；特别短的镜头可生成更长片段后裁剪。模型限制从当前配置读取，不硬编码，也不能为了满足生成时长修改成片切点。

例：成片某镜头 3.2 秒，目标模型本次配置最短 4 秒，则 `target_duration_us=3200000`、`request_duration_s=4`、`trim_range_us=[0,3200000]`。这两个时长用途不同。

### 8.2 每个生成任务的字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| task_id | string | 本工具的方案任务 ID，不是供应商 job ID |
| shot_ids | string[] | 需要复现的镜头 |
| target_model | string | 用户选择的目标生成模型，如 Seedance 2.5 |
| provenance | enum | inferred_plan；真正执行记录另存 |
| mode | enum | reference_to_video / text_to_video |
| style_id | string | 全局风格引用 |
| reference_bindings | array | 素材 ID、用途、角色/场景 ID、提示词引用名 |
| target_duration_us | integer | 成片需要保留的长度 |
| request_duration_s | number/null | 根据目标模型约束换算；未核对能力时为空并标待处理 |
| trim_range_us | integer[2]/null | 生成结果要保留的范围 |
| aspect_ratio | string | 与成片一致，如 9:16 |
| native_audio | boolean | 此方案开启原生音视频生成 |
| prompt_parts | object | 结构化提示词各部分 |
| prompt_text | string | 可复制使用的完整中文提示词 |
| avoid | string[] | 要避免的角色漂移、衣服变化等，按目标接口能力写入提示词 |
| continuity_constraints | string[] | 与邻镜头衔接要求 |
| status | enum | planned / ready_to_run / running / succeeded / failed |
| execution | object/null | 未实际调用时必须为 null |

参考图用于人物、场景和画风约束，不默认采用首尾关键帧插值生成。源视频抽出的参考图属于提取素材；需要角色设定图时可创建待生成图像任务，但没有实际生成就不标成功。

### 8.3 prompt_parts 必须包含的内容

| 字段 | 写法 |
| --- | --- |
| subject | 角色、衣服、外观参考绑定 |
| environment | 场景、物件、光照、空间关系 |
| composition | 景别、视角、人物位置 |
| action_sequence | 按顺序写开始状态、动作变化、结束状态 |
| camera | 镜头是否运动，运动方向和终点 |
| dialogue | 说话角色、逐字台词、语气、停顿 |
| audio | 环境声、音效、配乐存在与否及强弱 |
| style | 引用统一风格并补必要镜头光色 |
| continuity | 道具、衣服、动作方向和视线衔接 |
| exclusions | 不新增字幕、水印、人物等具体限制 |

示例：

> 竖屏 9:16，二维赛璐璐表现。角色参考 A 对应黑色短发、白衬衫的青年；场景参考 B 对应左侧有窗的客厅。平视中景，青年位于画面右侧面向左方。开始时双手自然垂下，随后转头看向左侧门口，身体保持原位，结束时保持注视。镜头固定，不变焦。青年用低沉、克制的普通话说“你终于来了。”，对白结束后留出反应停顿。保留轻微室内环境声，不新增强配乐。保持脸型、服装和窗户位置一致，不增加人物，不生成字幕和水印。

这是一条复现提示词示例，不是从真实视频恢复的原始提示词。人物和台词必须根据实际分析结果替换。

### 8.4 真正抽卡时记录什么

仅当用户实际执行生成，才向 execution 写入：供应商任务 ID、调用模型及参数、提交时间、返回状态、候选文件、预览图、选用候选 ID、实际费用。

没有执行时，HTML 显示“待生成”或“复现方案”；成片切片显示“成片参考”，不填随机成功时间、不复制同一片段冒充多个候选。

## 9. 给千问的输入与返回约束

### 第一轮：整集资产分析

输入整集有声代理、镜头清单、镜头代表帧。要求返回 styles、characters、scenes，以及每个 shot_id 对应的角色/场景关系。不要求重新给切点。

### 第二轮：逐镜头详细分析与生成方案

输入明确的 shot_id、固定时间区间、有声片段、前后镜头代表帧、已建立的角色和场景字典。要求返回本镜头描述、动作段、对白、字幕候选、声音事件和复现提示词。

建议先每批 4 个镜头，可配置；响应有截断就缩小批次重试，只重试缺失镜头，不重复全片分析。任何模型输入限制以实际 API 为准。

### 可直接使用的任务指令

```text
你负责将中文漫剧成片转换为逐镜头描述和可复现的生成方案。
输入提供的 shot_id、start_frame、end_frame_exclusive 和全局时间是固定值，不得修改。
对每个 shot_id 输出且只输出一条镜头分析，使用给定角色、外观和场景 ID。
逐项描述景别、视角、构图、运镜、起始状态、动作序列、结束状态。
对白保留原文；画面字幕和听到的语音分别记录，不一致时标记冲突。
不清楚说话人则 speaker_id=null，不允许根据剧情补对白。
镜头内部事件用 local_start_us/local_end_us；全局字幕和音频事件由程序加上镜头偏移。
给出人物和场景参考素材需求，以及包含动作、运镜、对白、声音的中文复现提示词。
不要写剧情长总结，不要用“人物活动”“镜头变化”等空泛描述代替实际动作。
每个字段按提供的 JSON Schema 返回。未知值用 null，并给出复核原因。
生成任务是拟定方案，不提供虚构的真实生成记录、候选数量和供应商任务 ID。
若输入片段实际包含多个切镜，列出 additional_cut_candidates；不要擅自改变固定边界。
只返回 JSON，不返回 Markdown 或额外解释。
```

生产调用须把对应字段表转换为 JSON Schema，一并提供；若接口支持结构化输出模式可启用，仍需检查返回的 ID、枚举和时间范围。格式损坏与内容缺失分别报告，不能用默认空白填满后声称分析完整。

## 10. 完整输出示例

下面是一个虚构的 8 秒、25 fps、两个镜头的小样，用于说明最终合并结果。路径代表执行后应生成的文件，不代表本文附带了这些素材。镜头帧边界确定；字幕时间示范保留 model_estimated 标记。示例只写一名已确认角色和一个场景，其他角色无法确认时不强行填写。

```json
{
  "schema_version": "2.0",
  "project_id": "demo_episode_001",
  "media": {
    "original_file": "source/input.mp4",
    "working_file": "source/working.mp4",
    "source_sha256": "<实际计算>",
    "width": 1080,
    "height": 1920,
    "fps_num": 25,
    "fps_den": 1,
    "total_frames": 200,
    "duration_us": 8000000,
    "has_audio": true,
    "audio_sample_rate": 48000,
    "normalized": false
  },
  "styles": [
    {
      "style_id": "style_001",
      "render_type": "二维赛璐璐",
      "linework": "细黑轮廓",
      "material": "平涂",
      "palette": "冷蓝灰",
      "lighting": "左侧冷光",
      "character_proportion": "写实比例",
      "evidence_frame_indices": [
        35,
        135
      ],
      "prompt_fragment": "二维赛璐璐，细黑轮廓，冷蓝环境光"
    }
  ],
  "characters": [
    {
      "character_id": "char_001",
      "display_name": "角色 A",
      "name_evidence": null,
      "face": "青年面部",
      "hair": "黑色短发",
      "body": "中等身形",
      "appearances": [
        {
          "appearance_id": "look_001",
          "clothing": "白色长袖衬衫",
          "accessories": [],
          "shot_ids": [
            "shot_001",
            "shot_002"
          ]
        }
      ],
      "reference_asset_ids": [
        "ref_char_001"
      ],
      "evidence_frame_indices": [
        35,
        135
      ],
      "prompt_fragment": "保持参考图中青年的脸型、黑色短发和白衬衫",
      "needs_review": false
    }
  ],
  "scenes": [
    {
      "scene_id": "scene_001",
      "name": "客厅",
      "location_type": "indoor",
      "layout": "左侧窗户，人物右侧站立",
      "time_of_day": null,
      "lighting": "窗侧冷光",
      "palette": "蓝灰色",
      "landmarks": [
        "左侧窗户"
      ],
      "reference_asset_ids": [
        "ref_scene_001"
      ],
      "evidence_frame_indices": [
        35
      ],
      "prompt_fragment": "保持左侧窗户和人物右侧站位的客厅"
    }
  ],
  "assets": [
    {
      "asset_id": "ref_char_001",
      "kind": "character_ref",
      "path": "assets/refs/char_001.jpg",
      "origin": "source_crop",
      "source_frame_index": 35,
      "crop_xyxy": [
        0.5,
        0.1,
        0.9,
        0.9
      ],
      "used_by_ids": [
        "char_001",
        "gen_001",
        "gen_002"
      ],
      "status": "ready"
    },
    {
      "asset_id": "ref_scene_001",
      "kind": "scene_ref",
      "path": "assets/refs/scene_001.jpg",
      "origin": "source_frame",
      "source_frame_index": 35,
      "crop_xyxy": null,
      "used_by_ids": [
        "scene_001",
        "gen_001",
        "gen_002"
      ],
      "status": "ready"
    },
    {
      "asset_id": "preview_001",
      "kind": "shot_preview",
      "path": "assets/thumbs/shot_001.jpg",
      "origin": "source_frame",
      "source_frame_index": 35,
      "crop_xyxy": null,
      "used_by_ids": [
        "shot_001"
      ],
      "status": "ready"
    },
    {
      "asset_id": "clip_001",
      "kind": "video_clip",
      "path": "assets/video/shot_001.mp4",
      "origin": "source_clip",
      "source_frame_index": null,
      "crop_xyxy": null,
      "used_by_ids": [
        "shot_001"
      ],
      "status": "ready"
    },
    {
      "asset_id": "preview_002",
      "kind": "shot_preview",
      "path": "assets/thumbs/shot_002.jpg",
      "origin": "source_frame",
      "source_frame_index": 135,
      "crop_xyxy": null,
      "used_by_ids": [
        "shot_002"
      ],
      "status": "ready"
    },
    {
      "asset_id": "clip_002",
      "kind": "video_clip",
      "path": "assets/video/shot_002.mp4",
      "origin": "source_clip",
      "source_frame_index": null,
      "crop_xyxy": null,
      "used_by_ids": [
        "shot_002"
      ],
      "status": "ready"
    },
    {
      "asset_id": "bg_001",
      "kind": "background_audio",
      "path": "assets/audio/background.wav",
      "origin": "separated_audio",
      "source_frame_index": null,
      "crop_xyxy": null,
      "used_by_ids": [
        "track_background"
      ],
      "status": "ready"
    }
  ],
  "shots": [
    {
      "shot_id": "shot_001",
      "order": 1,
      "start_frame": 0,
      "end_frame_exclusive": 100,
      "frame_count": 100,
      "start_us": 0,
      "end_us": 4000000,
      "duration_us": 4000000,
      "boundary_kind": "start",
      "boundary_status": "verified",
      "scene_id": "scene_001",
      "character_ids": [
        "char_001"
      ],
      "appearance_ids": [
        "look_001"
      ],
      "shot_size": "medium",
      "camera_angle": "eye_level",
      "composition": "人物在右侧面向左方",
      "camera_movement": [
        {
          "type": "static",
          "local_start_us": 0,
          "local_end_us": 4000000,
          "direction": null,
          "speed": null
        }
      ],
      "start_state": "双手垂下，身体站定",
      "action_beats": [
        {
          "local_start_us": 0,
          "local_end_us": 1500000,
          "actor_ids": [
            "char_001"
          ],
          "action": "转头望向门口",
          "object": "左侧门口",
          "result_state": "保持向左注视",
          "timing_method": "model_estimated"
        }
      ],
      "end_state": "保持向左注视",
      "subtitle_ids": [
        "sub_001"
      ],
      "audio_event_ids": [
        "aud_dialogue_001",
        "aud_room_001"
      ],
      "representative_frame": 35,
      "preview_asset_id": "preview_001",
      "clip_asset_id": "clip_001",
      "continuity": {
        "previous_shot_id": null,
        "next_shot_id": "shot_002",
        "constraints": [
          "白衬衫与发型一致",
          "视线保持向左"
        ]
      },
      "visual_description": "白衬衫青年站在客厅右侧，转头望向左侧门口并说话。",
      "uncertainty_codes": []
    },
    {
      "shot_id": "shot_002",
      "order": 2,
      "start_frame": 100,
      "end_frame_exclusive": 200,
      "frame_count": 100,
      "start_us": 4000000,
      "end_us": 8000000,
      "duration_us": 4000000,
      "boundary_kind": "hard_cut",
      "boundary_status": "verified",
      "scene_id": "scene_001",
      "character_ids": [
        "char_001"
      ],
      "appearance_ids": [
        "look_001"
      ],
      "shot_size": "close_up",
      "camera_angle": "eye_level",
      "composition": "面部特写，视线朝画面左侧",
      "camera_movement": [
        {
          "type": "static",
          "local_start_us": 0,
          "local_end_us": 4000000,
          "direction": null,
          "speed": null
        }
      ],
      "start_state": "已看向左侧门口",
      "action_beats": [
        {
          "local_start_us": 0,
          "local_end_us": 1500000,
          "actor_ids": [
            "char_001"
          ],
          "action": "轻微皱眉",
          "object": "左侧门口",
          "result_state": "保持向左注视",
          "timing_method": "model_estimated"
        }
      ],
      "end_state": "保持向左注视",
      "subtitle_ids": [],
      "audio_event_ids": [
        "aud_room_001"
      ],
      "representative_frame": 135,
      "preview_asset_id": "preview_002",
      "clip_asset_id": "clip_002",
      "continuity": {
        "previous_shot_id": "shot_001",
        "next_shot_id": null,
        "constraints": [
          "白衬衫与发型一致",
          "视线保持向左"
        ]
      },
      "visual_description": "青年面部特写，保持左向视线，皱眉后沉默。",
      "uncertainty_codes": []
    }
  ],
  "subtitle_cues": [
    {
      "subtitle_id": "sub_001",
      "display_text": "你终于来了。",
      "visual_text": "你终于来了。",
      "spoken_text": "你终于来了。",
      "text_source": "visual_and_audio",
      "text_conflict": false,
      "speaker_id": "char_001",
      "start_us": 1000000,
      "end_us": 2800000,
      "timing_method": "model_estimated",
      "timing_status": "estimated",
      "shot_ids": [
        "shot_001"
      ],
      "visible": false
    }
  ],
  "audio_events": [
    {
      "audio_event_id": "aud_dialogue_001",
      "type": "dialogue",
      "start_us": 1000000,
      "end_us": 2800000,
      "speaker_id": "char_001",
      "text": "你终于来了。",
      "description": "普通话，语气克制",
      "timing_method": "model_estimated",
      "timing_status": "estimated",
      "shot_ids": [
        "shot_001"
      ]
    },
    {
      "audio_event_id": "aud_room_001",
      "type": "ambience",
      "start_us": 0,
      "end_us": 8000000,
      "speaker_id": null,
      "text": null,
      "description": "轻微室内底噪",
      "timing_method": "model_estimated",
      "timing_status": "estimated",
      "shot_ids": [
        "shot_001",
        "shot_002"
      ]
    }
  ],
  "generation_tasks": [
    {
      "task_id": "gen_001",
      "shot_ids": [
        "shot_001"
      ],
      "target_model": "Seedance 2.5",
      "provenance": "inferred_plan",
      "mode": "reference_to_video",
      "style_id": "style_001",
      "reference_bindings": [
        {
          "asset_id": "ref_char_001",
          "purpose": "character",
          "entity_id": "char_001",
          "prompt_alias": "角色参考 A"
        },
        {
          "asset_id": "ref_scene_001",
          "purpose": "scene",
          "entity_id": "scene_001",
          "prompt_alias": "场景参考 B"
        }
      ],
      "target_duration_us": 4000000,
      "request_duration_s": null,
      "trim_range_us": null,
      "aspect_ratio": "9:16",
      "native_audio": true,
      "prompt_parts": {
        "subject": "角色参考 A：黑短发、白衬衫青年",
        "environment": "场景参考 B：左侧有窗的客厅",
        "composition": "平视中景，青年位于右侧",
        "action_sequence": "从站定到转头看向左侧，结束时保持注视",
        "camera": "镜头固定",
        "dialogue": "青年用克制的普通话说：你终于来了。",
        "audio": "轻微室内环境声，不新增强配乐",
        "style": "二维赛璐璐、细黑轮廓、冷蓝环境光",
        "continuity": "脸型、发型、白衬衫、视线方向保持一致",
        "exclusions": "不新增人物、字幕、水印"
      },
      "prompt_text": "竖屏 9:16。角色参考 A：黑短发、白衬衫青年。场景参考 B：左侧有窗的客厅。平视中景，青年位于右侧。从站定到转头看向左侧，结束时保持注视。镜头固定。青年用克制的普通话说：你终于来了。。轻微室内环境声，不新增强配乐。二维赛璐璐、细黑轮廓、冷蓝环境光。脸型、发型、白衬衫、视线方向保持一致。不新增人物、字幕、水印。",
      "avoid": [
        "角色脸型变化",
        "服装变化",
        "新增水印"
      ],
      "continuity_constraints": [
        "保持向左视线",
        "白衬衫一致"
      ],
      "status": "planned",
      "execution": null
    },
    {
      "task_id": "gen_002",
      "shot_ids": [
        "shot_002"
      ],
      "target_model": "Seedance 2.5",
      "provenance": "inferred_plan",
      "mode": "reference_to_video",
      "style_id": "style_001",
      "reference_bindings": [
        {
          "asset_id": "ref_char_001",
          "purpose": "character",
          "entity_id": "char_001",
          "prompt_alias": "角色参考 A"
        },
        {
          "asset_id": "ref_scene_001",
          "purpose": "scene",
          "entity_id": "scene_001",
          "prompt_alias": "场景参考 B"
        }
      ],
      "target_duration_us": 4000000,
      "request_duration_s": null,
      "trim_range_us": null,
      "aspect_ratio": "9:16",
      "native_audio": true,
      "prompt_parts": {
        "subject": "角色参考 A：黑短发、白衬衫青年",
        "environment": "场景参考 B：左侧有窗的客厅",
        "composition": "平视面部特写",
        "action_sequence": "保持左向注视，轻微皱眉后沉默",
        "camera": "镜头固定",
        "dialogue": "无对白",
        "audio": "轻微室内环境声，不新增强配乐",
        "style": "二维赛璐璐、细黑轮廓、冷蓝环境光",
        "continuity": "脸型、发型、白衬衫、视线方向保持一致",
        "exclusions": "不新增人物、字幕、水印"
      },
      "prompt_text": "竖屏 9:16。角色参考 A：黑短发、白衬衫青年。场景参考 B：左侧有窗的客厅。平视面部特写。保持左向注视，轻微皱眉后沉默。镜头固定。无对白。轻微室内环境声，不新增强配乐。二维赛璐璐、细黑轮廓、冷蓝环境光。脸型、发型、白衬衫、视线方向保持一致。不新增人物、字幕、水印。",
      "avoid": [
        "角色脸型变化",
        "服装变化",
        "新增水印"
      ],
      "continuity_constraints": [
        "保持向左视线",
        "白衬衫一致"
      ],
      "status": "planned",
      "execution": null
    }
  ],
  "workflow_nodes": [
    {
      "node_id": "node_style",
      "type": "style",
      "label": "统一风格",
      "entity_ids": [
        "style_001"
      ],
      "status": "analyzed"
    },
    {
      "node_id": "node_char",
      "type": "character_reference",
      "label": "角色参考",
      "entity_ids": [
        "char_001",
        "ref_char_001"
      ],
      "status": "extracted"
    },
    {
      "node_id": "node_scene",
      "type": "scene_reference",
      "label": "场景参考",
      "entity_ids": [
        "scene_001",
        "ref_scene_001"
      ],
      "status": "extracted"
    },
    {
      "node_id": "node_shot_1",
      "type": "storyboard",
      "label": "分镜 1",
      "entity_ids": [
        "shot_001"
      ],
      "status": "analyzed"
    },
    {
      "node_id": "node_gen_1",
      "type": "video_generation_plan",
      "label": "镜头 1 复现方案",
      "entity_ids": [
        "gen_001"
      ],
      "status": "planned"
    },
    {
      "node_id": "node_clip_1",
      "type": "source_clip",
      "label": "成片片段 1",
      "entity_ids": [
        "clip_001"
      ],
      "status": "extracted"
    },
    {
      "node_id": "node_shot_2",
      "type": "storyboard",
      "label": "分镜 2",
      "entity_ids": [
        "shot_002"
      ],
      "status": "analyzed"
    },
    {
      "node_id": "node_gen_2",
      "type": "video_generation_plan",
      "label": "镜头 2 复现方案",
      "entity_ids": [
        "gen_002"
      ],
      "status": "planned"
    },
    {
      "node_id": "node_clip_2",
      "type": "source_clip",
      "label": "成片片段 2",
      "entity_ids": [
        "clip_002"
      ],
      "status": "extracted"
    },
    {
      "node_id": "node_edit",
      "type": "edit",
      "label": "剪映编辑",
      "entity_ids": [
        "track_video",
        "track_background",
        "track_subtitles",
        "track_watermark"
      ],
      "status": "planned"
    }
  ],
  "workflow_edges": [
    {
      "from_node_id": "node_style",
      "to_node_id": "node_gen_1",
      "relation": "plan_input"
    },
    {
      "from_node_id": "node_char",
      "to_node_id": "node_gen_1",
      "relation": "plan_input"
    },
    {
      "from_node_id": "node_scene",
      "to_node_id": "node_gen_1",
      "relation": "plan_input"
    },
    {
      "from_node_id": "node_shot_1",
      "to_node_id": "node_gen_1",
      "relation": "plan_input"
    },
    {
      "from_node_id": "node_clip_1",
      "to_node_id": "node_shot_1",
      "relation": "analysis_evidence"
    },
    {
      "from_node_id": "node_style",
      "to_node_id": "node_gen_2",
      "relation": "plan_input"
    },
    {
      "from_node_id": "node_char",
      "to_node_id": "node_gen_2",
      "relation": "plan_input"
    },
    {
      "from_node_id": "node_scene",
      "to_node_id": "node_gen_2",
      "relation": "plan_input"
    },
    {
      "from_node_id": "node_shot_2",
      "to_node_id": "node_gen_2",
      "relation": "plan_input"
    },
    {
      "from_node_id": "node_clip_2",
      "to_node_id": "node_shot_2",
      "relation": "analysis_evidence"
    },
    {
      "from_node_id": "node_clip_1",
      "to_node_id": "node_edit",
      "relation": "actual_media_input"
    },
    {
      "from_node_id": "node_clip_2",
      "to_node_id": "node_edit",
      "relation": "actual_media_input"
    }
  ],
  "timeline": {
    "video": {
      "track_id": "track_video",
      "volume": 1.0,
      "clips": [
        {
          "shot_id": "shot_001",
          "asset_id": "clip_001",
          "source_start_us": 0,
          "timeline_start_us": 0,
          "duration_us": 4000000
        },
        {
          "shot_id": "shot_002",
          "asset_id": "clip_002",
          "source_start_us": 0,
          "timeline_start_us": 4000000,
          "duration_us": 4000000
        }
      ]
    },
    "background": {
      "track_id": "track_background",
      "asset_id": "bg_001",
      "timeline_start_us": 0,
      "duration_us": 8000000,
      "volume": 0.0
    },
    "subtitles": {
      "track_id": "track_subtitles",
      "cue_ids": [
        "sub_001"
      ],
      "visible": false
    },
    "watermark": {
      "track_id": "track_watermark",
      "enabled": false,
      "asset_id": null
    }
  },
  "review_items": [
    {
      "id": "review_001",
      "entity_ids": [
        "gen_001",
        "gen_002"
      ],
      "code": "model_constraints_unchecked",
      "message": "生成请求时长待核对目标模型能力后填写",
      "blocks": [
        "generation_execution"
      ]
    }
  ],
  "usage": null
}
```

## 11. HTML 工程图怎么填

沿用用户现有模板，字段映射以实际模板为准。逻辑依赖必须真实反映这次分析与方案，不只把几段文字塞进卡片。

| 模板节点 | 读取内容 | 节点图片 | 应显示的状态 |
| --- | --- | --- | --- |
| 风格设定 | styles 的可见特征和 prompt_fragment | 可选真实风格参考帧 | 分析所得 |
| 角色参考 | characters、appearances | 成片裁剪出的角色图 | 已提取；没有三视图就不显示三视图 |
| 场景参考 | scenes | 成片场景参考帧 | 已提取 |
| 分镜卡片 | shots：编号、帧区间、时长、景别、动作、对白 | representative_frame 对应真实截图 | 已分析/待确认 |
| 视频生成方案 | generation_tasks：模型、参考绑定、时长、提示词、音频要求 | 参考图；可附成片目标示例 | 待生成/复现方案 |
| 成片片段 | assets 中 source_clip | 独立切片预览 | 已截取 |
| 剪辑输出 | timeline 与实际草稿输出状态 | 实际素材/时间轴数据的模板展示 | 已组装或待验证 |

连线分两种：

- 方案输入关系：角色参考、场景参考、风格和分镜指向视频生成方案。
- 实际素材关系：已截取的成片片段、背景声音、字幕、水印指向剪辑节点。

未执行的视频生成任务不能画成“已生成结果 → 当前成片”的事实关系。若将来真正执行生成，才添加实际生成素材及其选用关系。

生成 PNG 前检查所有图像和字体加载完成。模板里的镜头编号、时长、图片路径必须从同一份数据读取，禁止为展示随机填充时长或抽卡次数。用户模板尚未提供，本文定义内容映射，不推定其 DOM 结构或视觉布局。

## 12. 剪映四轨如何落地

| 轨道 | 素材 | 时间与默认行为 |
| --- | --- | --- |
| 视频 | 按确定帧区间切出的独立 MP4 | 每片段素材入点为 0，时间轴位置取 shot.start_us；保留原声 |
| 背景声 | 整集 Demucs 非人声结果 | 从 0 开始，覆盖整集，默认静音 |
| 字幕 | subtitle_cues 转成 SRT/文字片段 | 使用全局时间；已有硬字幕时隐藏或透明，可重新启用 |
| 水印 | 用户 PNG 或文字 | 默认覆盖整集，位置与大小可调；未提供时不虚构素材 |

原声已经包含对白、背景声和音效。独立背景轨是备用素材；开启后会与原声叠加，不能默认重复播放。Demucs 的非人声结果可能含环境声、音效与人声残留，不称为无损纯音乐。

草稿生成工具在用户剪映完整版本上完成“打开—播放—编辑—保存—退出—重开”后才能采用。可评估 jy-headless、jianying-headless、pyJianYingDraft，但不要把候选仓库的宣传当成 Mac 兼容验证；其中版本与许可证限制需逐项确认。

没有水印时允许三条实际轨道。有工具不保留空轨也无需添加无效占位。

## 13. 输出校验：不让下游再猜

### 必须阻止切片/导出的错误

- 帧区间为负、反向、超出总帧数、存在缺口或重复覆盖。
- 镜头 clip_asset_id 指向不存在或打不开的文件。
- 角色、场景、字幕、节点引用了不存在的 ID。
- 标记 ready 的参考图没有真实文件。
- 切片实际视频帧数与计划 frame_count 不一致。
- HTML 采用旧数据，草稿采用新数据，导致镜头编号或时长不同。

### 允许继续，但必须保留明确待确认项

- 角色姓名、说话人未知：用临时角色 ID 或 null，仍可切片。
- 遮挡导致参考图质量低：生成方案保留缺失素材任务，不编补图。
- 字幕时间尚未校准：hidden 字幕可导出，但 timing_status 不得设 verified。
- 生成请求参数尚未核对：允许导出方案图和成片剪辑草稿，禁止实际提交生成。
- 过渡效果导致无唯一切点：采用明确 midpoint 规则并记录，不随机选择。

### 修改时如何保持一致

- 改切点：重新计算相邻镜头边界、时长、缩略图、字幕关联，重切受影响片段并重导 HTML/草稿；背景声无需重分离。
- 改台词：更新字幕和相关生成提示词，重新导出；不必重切视频。
- 改角色归属：更新角色引用、参考素材绑定和提示词，不动已确定镜头边界。
- 改生成模型：重新校验生成时长和参考素材限制，不改成片片段时长。

## 14. 交付内容与执行优先级

交付：完整分析结果 JSON、生成流程方案、填充后的 HTML 与 PNG、独立镜头 MP4、参考图和预览图、背景声、SRT、剪映草稿。

开发验证顺序：

1. 用一集视频完成确定帧边界与独立切片，证明能完整拼回。
2. 用目标剪映版本完成四轨小样，确认真实可打开和保存。
3. 接入千问两轮分析，逐项检查角色引用、动作、字幕和生成提示词。
4. 对接用户已有 HTML 模板，保证图中镜头与视频片段一一对应。
5. 加入生成参数检查、待确认项和重新导出，再扩展批量处理。

需要用户提供：一集代表视频、原 HTML 模板、剪映完整版本号、可选水印。未提供前可设计数据规则，不能宣称已完成实际效果验证。

## 15. 费用说明

此前“2～3 分钟约 0.05～0.15 元”只用于单次分析预算。本版采用整集资产分析加逐镜头详细分析，输入会重复、输出会更多，不能继续按单次价格承诺。

费用按实际调用累计：普通输入 Token × 当前输入单价，加输出 Token × 当前输出单价，缓存按适用价格另计。首集记录调用次数、输入和输出用量、重试费用后，才给出本方案每集成本。

## 16. 参考来源与边界

- 千问音视频理解与输入规范：https://help.aliyun.com/zh/model-studio/qwen-omni
- 千问 API 价格：https://help.aliyun.com/zh/model-studio/model-pricing
- PySceneDetect 检测器与参数：https://www.scenedetect.com/docs/latest/api/detectors.html
- FFmpeg 的裁剪与时间戳处理：https://ffmpeg.org/ffmpeg.html
- Demucs：https://github.com/adefossez/demucs
- jy-headless：https://github.com/partme-ai/jy-headless
- jianying-headless：https://github.com/mcncarl/jianying-headless
- pyJianYingDraft：https://github.com/GuanYixuan/pyJianYingDraft

工具能力以官方文档和样片验证为准。本文字段、时间规范、默认批量数量和映射方式是本项目方案设计，不是第三方接口原生字段。没有承诺大模型逐帧准确；准确的可执行分镜边界来自本地视频帧检测及必要复核。
