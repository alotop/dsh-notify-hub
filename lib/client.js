// dsh-notify-hub — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-notify-hub/client.js and executed
// through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with require()
// resolved against the shell's module table (react, react/jsx-runtime, and the
// seeded @deepseek-ai/dsh-client-store).
//
// This half registers the 「通知集合」settings section (settings.section slot)
// and talks to the Host exclusively through the /dsh-notify-hub loopback RPC:
// every credential (Bark endpoint, webhook URLs, 移动新消息 API Key) is hosted on
// the Host and never crosses the wire — the section reads a masked status and
// writes new values only.
window.__ModuleLoader__.load({
	id: "dsh-notify-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _client_store = require("@deepseek-ai/dsh-client-store");

		const h = react.createElement;

		//#region dsh-notify-hub: definitions
		/** The settings section's locale namespace. */
		const NS = "notify-hub";
		/** Logical RPC channel owned by this plugin. */
		const RPC_CHANNEL = "/dsh-notify-hub";
		/** Settings event flags, in display order. */
		const EVENT_KEYS = [
			"completed", "error", "blocked", "aborted",
			"maxTokens", "interrupted", "question", "approval", "planReview",
		];
		/** Webhook presets, in display order. */
		const WEBHOOK_KEYS = ["feishu", "wecom", "dingtalk", "slack", "discord", "custom"];
		/** Every channel id the hub serves, in the order the section renders them. */
		const CHANNEL_KEYS = ["bark", "cmcc", "local", ...WEBHOOK_KEYS];
		/**
		 * Webhook channels whose provider supports bot-side security settings
		 * (自定义关键词 / 签名校验). Mirrors WEBHOOK_SECURITY on the Host: a control is
		 * only rendered where the provider would honour it.
		 */
		const SECURITY_CHANNELS = { feishu: true };
		/** Bark push levels. */
		const BARK_LEVELS = ["active", "timeSensitive", "passive", "critical"];
		//#endregion

		//#region dsh-notify-hub: locales
		const zh = {
			nav: "通知集合",
			title: "通知集合",
			intro: "DSH Host 在回合结束、等待回答、等待授权等事件发生时，同时推送到 Bark、「移动新消息」(5G 消息)、桌面通知与多路 Webhook。浏览器关掉也照常推送。",
			loading: "加载中…",
			loadError: "设置加载失败：{error}",
			saveFailed: "保存失败：{error}",
			saved: "已保存",
			master: "启用通知集合",
			masterHint: "总开关。关闭后不再发送任何通知。",
			localeLabel: "通知语言",
			subagents: "同时通知子 Agent 会话",
			subagentsHint: "默认只通知主会话，避免子 Agent 刷屏。",
			statusTitle: "运行状态",
			statusPlatform: "平台",
			statusLocal: "桌面通知后端",
			statusQueue: "投递队列",
			statusQueueValue: "{count} / 100",
			channelsTitle: "通知通道",
			channelsHint: "每个通道独立开关：开关打开且凭据填写完整后才会投递。",
			enabled: "启用",
			configured: "已配置 {masked}",
			unconfigured: "未配置",
			partial: "缺少接收号码",
			test: "测试",
			testing: "发送中…",
			testAll: "测试全部通道",
			testSent: "测试通知已发送",
			testFailed: "测试失败：{error}",
			save: "保存",
			saving: "保存中…",
			probe: "检测连接",
			probing: "连接中…",
			connected: "已连接",
			disconnected: "未连接",
			barkUrl: "Bark 推送地址",
			barkUrlPlaceholder: "https://api.day.app/xxxxxxxx",
			barkUrlHint: "官方 Bark 或自建 Server 均可。填写后立即生效，地址不回显。",
			barkGroup: "Bark Group",
			barkGroupHint: "同一 Group 的推送在手机上聚合。",
			barkLevel: "推送级别",
			barkSound: "提示音",
			barkSoundHint: "留空使用 Bark 默认提示音。",
			cmccKey: "移动新消息 API Key",
			cmccKeyPlaceholder: "ak_xxx 或 app_xxx",
			cmccKeyHint: "从管理员处获取，仅保存在 Host 端，不会回传浏览器。",
			cmccTo: "接收号码",
			cmccToHint: "推送目标（手机号或用户标识）。",
			cmccServer: "WebSocket 地址",
			cmccServerHint: "默认使用中国移动 5G 消息网关，自建网关可修改。",
			cmccUpload: "上传地址",
			cmccPrefix: "文本前缀",
			cmccSummary: "附带内容摘要",
			cmccProbeHint: "建立长连接并完成鉴权，验证 Key 与网络是否可用。",
			cmccMediaTitle: "富媒体推送（可选）",
			cmccMediaHint: "填写本机图片路径后上传到 5G 消息网关并推送，用于验证图片/文件通道。",
			cmccMediaPath: "本地文件路径",
			cmccMediaCaption: "附带文案",
			cmccMediaSend: "发送图片",
			cmccMediaMissing: "请先填写本地文件路径",
			localSound: "播放提示音",
			localUnsupported: "当前平台不支持桌面通知",
			webhookUrl: "Webhook 地址",
			webhookUrlHint: "复制群机器人 Webhook 地址粘贴到这里。",
			webhookSummary: "附带内容摘要",
			webhookSecurityTitle: "机器人安全设置",
			webhookKeyword: "自定义关键词",
			webhookKeywordPlaceholder: "例如 dsh-notify-hub",
			webhookKeywordHint: "飞书机器人开启「自定义关键词」后，消息正文必须包含该关键词。填写后会自动加在正文最前面；留空表示未开启。",
			webhookSecret: "签名校验密钥",
			webhookSecretPlaceholder: "粘贴飞书机器人提供的秘钥",
			webhookSecretHint: "飞书机器人开启「签名校验」后，每次请求都会自动携带 timestamp 与 sign（HmacSHA256）。密钥只保存在 Host 端，不回显。",
			eventsTitle: "触发事件",
			eventsHint: "勾选需要推送的事件类型。",
			"event.completed": "任务完成",
			"event.error": "执行错误",
			"event.blocked": "执行被阻塞",
			"event.aborted": "手动中止",
			"event.maxTokens": "Token 达到上限",
			"event.interrupted": "异常中断",
			"event.question": "等待我回答",
			"event.approval": "等待授权",
			"event.planReview": "等待计划确认",
			contentTitle: "通知内容",
			includeAssistant: "附带 AI 最后一段回复",
			includeAssistantHint: "任务完成类通知附带模型最后一段回复，便于在手机上直接阅读结论。",
			maxBodyChars: "正文长度上限",
			historyLimit: "记录条数",
			historyLimitHint: "设置页最多保留多少条投递记录（0 表示不记录）。",
			rulesTitle: "内容过滤规则",
			rulesHint: "按顺序匹配通知标题 / 摘要 / 原因。exclude 命中即静默；存在 include 规则时，只有命中的通知才推送。",
			ruleAdd: "添加规则",
			ruleRemove: "删除",
			ruleInclude: "仅推送命中",
			ruleExclude: "命中则忽略",
			rulePattern: "匹配内容",
			ruleRegex: "正则",
			ruleCase: "区分大小写",
			routesTitle: "通道路由",
			routesHint: "把通知按会话/内容分流到指定通道。第一条命中的规则生效；未命中任何规则时推送到全部已启用通道。",
			routeAdd: "添加路由",
			routePattern: "匹配内容",
			routeChannels: "目标通道",
			historyTitle: "最近投递",
			historyHint: "Host 端最近 {count} 条投递记录。",
			historyEmpty: "暂无投递记录。",
			historyClear: "清空记录",
			historyOk: "成功",
			historyFail: "失败",
			noChannels: "还没有已启用且配置完整的通道，请先在上方配置。",
		};
		const en = {
			nav: "Notification Hub",
			title: "Notification Hub",
			intro: "The DSH Host pushes turn endings, questions, and approval requests to Bark, China Mobile 5G messages, desktop notifications, and any number of webhooks at once — even with the browser closed.",
			loading: "Loading…",
			loadError: "Failed to load settings: {error}",
			saveFailed: "Failed to save: {error}",
			saved: "Saved",
			master: "Enable the notification hub",
			masterHint: "Master switch. When off, nothing is delivered.",
			localeLabel: "Notification language",
			subagents: "Also notify subagent sessions",
			subagentsHint: "Off by default so subagents cannot flood your phone.",
			statusTitle: "Status",
			statusPlatform: "Platform",
			statusLocal: "Desktop backend",
			statusQueue: "Delivery queue",
			statusQueueValue: "{count} / 100",
			channelsTitle: "Channels",
			channelsHint: "Each channel is independent: it must be switched on and fully configured.",
			enabled: "Enabled",
			configured: "Configured {masked}",
			unconfigured: "Not configured",
			partial: "Recipient missing",
			test: "Test",
			testing: "Sending…",
			testAll: "Test every channel",
			testSent: "Test notification sent",
			testFailed: "Test failed: {error}",
			save: "Save",
			saving: "Saving…",
			probe: "Check connection",
			probing: "Connecting…",
			connected: "Connected",
			disconnected: "Disconnected",
			barkUrl: "Bark endpoint",
			barkUrlPlaceholder: "https://api.day.app/xxxxxxxx",
			barkUrlHint: "Official Bark or a self-hosted server. Applied immediately; the value is never shown back.",
			barkGroup: "Bark group",
			barkGroupHint: "Pushes in one group aggregate on the phone.",
			barkLevel: "Push level",
			barkSound: "Sound",
			barkSoundHint: "Leave empty for the Bark default.",
			cmccKey: "China Mobile API key",
			cmccKeyPlaceholder: "ak_xxx or app_xxx",
			cmccKeyHint: "Issued by your administrator. Stored on the Host only.",
			cmccTo: "Recipient",
			cmccToHint: "Push target (phone number or user id).",
			cmccServer: "WebSocket URL",
			cmccServerHint: "Defaults to the China Mobile gateway; change it for a self-hosted one.",
			cmccUpload: "Upload URL",
			cmccPrefix: "Text prefix",
			cmccSummary: "Include the summary",
			cmccProbeHint: "Opens the long connection and completes the handshake to verify the key and the network.",
			cmccMediaTitle: "Rich media (optional)",
			cmccMediaHint: "Upload a local image to the 5G gateway and push it — verifies the media path.",
			cmccMediaPath: "Local file path",
			cmccMediaCaption: "Caption",
			cmccMediaSend: "Send image",
			cmccMediaMissing: "Enter a local file path first",
			localSound: "Play a sound",
			localUnsupported: "Desktop notifications are unsupported on this platform",
			webhookUrl: "Webhook URL",
			webhookUrlHint: "Paste the group-bot webhook URL here.",
			webhookSummary: "Include the summary",
			webhookSecurityTitle: "Bot security",
			webhookKeyword: "Custom keyword",
			webhookKeywordPlaceholder: "e.g. dsh-notify-hub",
			webhookKeywordHint: "With 飞书「自定义关键词」 enabled, the message text must contain the keyword. It is prepended to the body automatically; leave empty when the feature is off.",
			webhookSecret: "Signature secret",
			webhookSecretPlaceholder: "Paste the secret 飞书 gives you",
			webhookSecretHint: "With 飞书「签名校验」 enabled, every request carries a timestamp and an HmacSHA256 sign automatically. The secret stays on the Host and is never shown back.",
			eventsTitle: "Events",
			eventsHint: "Pick the events that should notify.",
			"event.completed": "Task completed",
			"event.error": "Execution error",
			"event.blocked": "Blocked",
			"event.aborted": "Aborted",
			"event.maxTokens": "Token limit reached",
			"event.interrupted": "Interrupted",
			"event.question": "Waiting for my answer",
			"event.approval": "Waiting for approval",
			"event.planReview": "Plan review",
			contentTitle: "Content",
			includeAssistant: "Include the AI's last reply",
			includeAssistantHint: "Completion notifications append the model's last reply so the conclusion is readable on the phone.",
			maxBodyChars: "Max body length",
			historyLimit: "History entries",
			historyLimitHint: "How many delivery records the section keeps (0 disables recording).",
			rulesTitle: "Content rules",
			rulesHint: "Matched in order against title / summary / reason. An exclude hit stays silent; when include rules exist, only hits notify.",
			ruleAdd: "Add rule",
			ruleRemove: "Remove",
			ruleInclude: "Only matching",
			ruleExclude: "Ignore matching",
			rulePattern: "Pattern",
			ruleRegex: "Regex",
			ruleCase: "Case sensitive",
			routesTitle: "Channel routes",
			routesHint: "Split notifications across channels by session or content. The first matching route wins; with no match every enabled channel is used.",
			routeAdd: "Add route",
			routePattern: "Pattern",
			routeChannels: "Channels",
			historyTitle: "Recent deliveries",
			historyHint: "The Host keeps the last {count} delivery attempts.",
			historyEmpty: "No deliveries recorded yet.",
			historyClear: "Clear",
			historyOk: "ok",
			historyFail: "failed",
			noChannels: "No channel is enabled and fully configured yet — configure one above.",
		};
		//#endregion

		//#region dsh-notify-hub: styles
		const css = [
			".dsnh_section{max-width:820px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:16px;display:flex}",
			".dsnh_heading{margin:0;font-size:18px;font-weight:600}",
			".dsnh_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}",
			".dsnh_group{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:12px;flex-direction:column;gap:10px;padding:12px 14px;display:flex}",
			".dsnh_groupTitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
			".dsnh_row{align-items:center;gap:10px;display:flex;flex-wrap:wrap}",
			".dsnh_between{justify-content:space-between}",
			".dsnh_check{color:var(--dsw-alias-label-primary);align-items:center;gap:8px;cursor:pointer;font-size:13px;line-height:20px;display:inline-flex}",
			".dsnh_check input{accent-color:var(--dsw-alias-state-business-primary);flex:none}",
			".dsnh_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);height:32px;min-width:0;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;flex:1;padding:0 10px;font-size:13px}",
			".dsnh_input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
			".dsnh_input::placeholder{color:var(--dsw-alias-label-tertiary)}",
			".dsnh_num{max-width:110px}",
			".dsnh_label{color:var(--dsw-alias-label-secondary);font-size:13px;flex:none;min-width:96px}",
			".dsnh_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}",
			".dsnh_button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:8px;flex:none;padding:5px 12px;font-size:13px}",
			".dsnh_button:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}",
			".dsnh_button:disabled{opacity:.5;cursor:default}",
			".dsnh_statusOk{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}",
			".dsnh_statusError{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}",
			".dsnh_badge{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;flex:none}",
			".dsnh_badgeOn{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
			".dsnh_badgeOff{color:var(--dsw-alias-label-tertiary)}",
			".dsnh_card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;flex-direction:column;gap:8px;padding:10px 12px;display:flex;background:var(--dsw-alias-bg-layer-1)}",
			".dsnh_cardHead{align-items:center;gap:8px;display:flex;flex-wrap:wrap}",
			".dsnh_cardName{font-size:13px;font-weight:600}",
			".dsnh_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px 14px}",
			".dsnh_history{max-height:220px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}",
			".dsnh_historyRow{border-bottom:1px solid var(--dsw-alias-border-l2);gap:8px;padding:6px 10px;font-size:12px;display:flex;align-items:center;flex-wrap:wrap}",
			".dsnh_historyRow:last-child{border-bottom:none}",
			".dsnh_mono{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);flex:none}",
			".dsnh_chip{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:999px;cursor:pointer;font:inherit;padding:2px 10px;font-size:12px}",
			".dsnh_chipOn{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-inverse,#fff)}",
			".dsnh_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);height:32px;border-radius:8px;padding:0 8px;font:inherit;font-size:13px}",
		].join("");
		const tagId = "dsh-notify-hub/HubSettings";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-notify-hub";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const styles = {
			section: "dsnh_section", heading: "dsnh_heading", intro: "dsnh_intro",
			group: "dsnh_group", groupTitle: "dsnh_groupTitle", row: "dsnh_row",
			between: "dsnh_between", check: "dsnh_check", input: "dsnh_input",
			num: "dsnh_num", label: "dsnh_label", hint: "dsnh_hint",
			button: "dsnh_button", statusOk: "dsnh_statusOk", statusError: "dsnh_statusError",
			badge: "dsnh_badge", badgeOn: "dsnh_badgeOn", badgeOff: "dsnh_badgeOff",
			card: "dsnh_card", cardHead: "dsnh_cardHead", cardName: "dsnh_cardName",
			grid: "dsnh_grid", history: "dsnh_history", historyRow: "dsnh_historyRow",
			mono: "dsnh_mono", chip: "dsnh_chip", chipOn: "dsnh_chipOn", select: "dsnh_select",
		};
		//#endregion

		//#region dsh-notify-hub: section controller
		/** Host transport for the section: read, write, test, probe, and the delivery log. */
		var HubSectionController = class {
			constructor(connection) {
				this.connection = connection;
				this.store = (0, _client_store.createSnapshotStore)({
					phase: "loading",
					settings: null,
					status: null,
					history: [],
					saveError: null,
					notice: null,
					saving: false,
					busy: null,
					testResult: null,
				});
				this.load();
			}
			async call(endpoint, payload) {
				const result = await this.connection.rpc.call(RPC_CHANNEL, endpoint, payload ?? {});
				if (!result || result.ok !== true) {
					throw new Error((result && result.error && result.error.message) || "RPC failed");
				}
				return result.value;
			}
			async load() {
				try {
					const value = await this.call("get");
					this.store.update((draft) => {
						draft.phase = "ready";
						draft.settings = value.settings;
						draft.status = value.status;
						draft.history = value.history || [];
						draft.saveError = null;
					});
				} catch (error) {
					this.store.update((draft) => {
						draft.phase = "error";
						draft.saveError = error instanceof Error ? error.message : String(error);
					});
				}
			}
			async save(patch, optimistic) {
				this.store.update((draft) => {
					draft.saving = true;
					draft.saveError = null;
					draft.notice = null;
					if (optimistic && draft.settings) draft.settings = assignDeep(draft.settings, patch);
				});
				try {
					await this.call("set", { patch });
					await this.load();
					this.store.update((draft) => { draft.notice = "saved"; });
				} catch (error) {
					this.store.update((draft) => {
						draft.saveError = error instanceof Error ? error.message : String(error);
					});
					await this.load();
				} finally {
					this.store.update((draft) => { draft.saving = false; });
				}
			}
			async test(channel, payload) {
				this.store.update((draft) => {
					draft.busy = channel;
					draft.testResult = null;
				});
				try {
					const value = await this.call("test", Object.assign({ channel }, payload || {}));
					const results = (value && value.results) || [];
					const failed = results.filter((entry) => !entry.ok);
					this.store.update((draft) => {
						draft.testResult = failed.length === 0
							? { ok: true, message: "sent" }
							: { ok: false, message: failed.map((entry) => entry.channel + ": " + entry.error).join("; ") };
					});
				} catch (error) {
					this.store.update((draft) => {
						draft.testResult = { ok: false, message: error instanceof Error ? error.message : String(error) };
					});
				} finally {
					this.store.update((draft) => { draft.busy = null; });
					await this.load();
				}
			}
			async probe() {
				this.store.update((draft) => { draft.busy = "probe"; });
				try {
					const status = await this.call("probe");
					this.store.update((draft) => {
						draft.testResult = status.ok
							? { ok: true, message: "connected" }
							: { ok: false, message: status.error || "probe failed" };
					});
				} catch (error) {
					this.store.update((draft) => {
						draft.testResult = { ok: false, message: error instanceof Error ? error.message : String(error) };
					});
				} finally {
					this.store.update((draft) => { draft.busy = null; });
					await this.load();
				}
			}
			async clearHistory() {
				try {
					await this.call("clearHistory");
				} catch (error) {
					// A failed clear is not worth blocking the section; the reload shows the truth.
				}
				await this.load();
			}
		};

		/** Merge a patch into a settings view the way the Host would (optimistic UI only). */
		function assignDeep(target, patch) {
			const output = Object.assign({}, target);
			for (const key of Object.keys(patch)) {
				const value = patch[key];
				if (value && typeof value === "object" && !Array.isArray(value)) {
					output[key] = assignDeep(output[key] || {}, value);
				} else {
					output[key] = value;
				}
			}
			return output;
		}
		//#endregion

		//#region dsh-notify-hub: presentational helpers
		function badge(text, on) {
			return h("span", { className: styles.badge + " " + (on ? styles.badgeOn : styles.badgeOff) }, text);
		}

		function checkbox(label, checked, onChange) {
			return h("label", { className: styles.check }, [
				h("input", { type: "checkbox", checked: checked === true, onChange: (event) => onChange(event.target.checked) }),
				h("span", null, label),
			]);
		}

		function textRow(label, props) {
			return h("div", { className: styles.row }, [
				h("span", { className: styles.label }, label),
				h("input", Object.assign({ className: styles.input, type: "text" }, props)),
			]);
		}

		function numberRow(label, props) {
			return h("div", { className: styles.row }, [
				h("span", { className: styles.label }, label),
				h("input", Object.assign({ className: styles.input + " " + styles.num, type: "number" }, props)),
			]);
		}

		function selectRow(label, value, options, onChange) {
			return h("div", { className: styles.row }, [
				h("span", { className: styles.label }, label),
				h("select", {
					className: styles.select,
					value,
					onChange: (event) => onChange(event.target.value),
				}, options.map((option) => h("option", { key: option.value, value: option.value }, option.label))),
			]);
		}

		/** A write-only credential field: never echoes the stored value back. */
		function secretRow(options) {
			return h("div", { className: styles.row }, [
				h("span", { className: styles.label }, options.label),
				h("input", {
					className: styles.input,
					type: "password",
					placeholder: options.placeholder,
					value: options.value,
					onChange: (event) => options.onChange(event.target.value),
					onBlur: options.onCommit,
					onKeyDown: (event) => { if (event.key === "Enter") options.onCommit(); },
				}),
				h("button", {
					type: "button",
					className: styles.button,
					disabled: options.value.trim().length === 0 || options.disabled,
					onClick: options.onCommit,
				}, options.saveLabel),
			]);
		}

		function formatTime(ms) {
			try {
				return new Date(ms).toLocaleTimeString();
			} catch (error) {
				return String(ms);
			}
		}
		//#endregion

		//#region dsh-notify-hub: settings section
		/**
		 * Render the notification hub section: master switch, live status, one card
		 * per channel, the event matrix, content options, rules, routes, and the
		 * recent-delivery log.
		 */
		function HubSettingsSection(props) {
			const t = props.t;
			const controller = props.controller;
			const useSnapshot = props.useSnapshot;
			const snap = useSnapshot((state) => state);
			const [drafts, setDrafts] = react.useState({});
			const [mediaPath, setMediaPath] = react.useState("");
			const [mediaCaption, setMediaCaption] = react.useState("");

			const setDraft = (key, value) => setDrafts((current) => Object.assign({}, current, { [key]: value }));
			const clearDraft = (key) => setDrafts((current) => {
				const next = Object.assign({}, current);
				delete next[key];
				return next;
			});
			const draftOf = (key, fallback) => (drafts[key] !== undefined ? drafts[key] : fallback);

			if (snap.phase === "loading") return h("p", { className: styles.hint }, t("loading"));
			if (snap.phase === "error" || !snap.settings) {
				return h("p", { className: styles.statusError, role: "alert" }, t("loadError", { error: snap.saveError || "?" }));
			}

			const settings = snap.settings;
			const status = snap.status || { channels: [] };
			const statusById = {};
			for (const entry of status.channels || []) statusById[entry.id] = entry;

			/** Save one scalar field and drop its draft. */
			const saveField = (patch, draftKey) => {
				if (draftKey) clearDraft(draftKey);
				void controller.save(patch, true);
			};

			const commitText = (key, build) => {
				const raw = drafts[key];
				if (raw === undefined) return;
				const patch = build(String(raw));
				if (patch === null) { clearDraft(key); return; }
				saveField(patch, key);
			};

			const commitNumber = (key, build) => {
				const raw = drafts[key];
				if (raw === undefined) return;
				const parsed = Number(raw);
				if (!Number.isFinite(parsed)) { clearDraft(key); return; }
				saveField(build(Math.round(parsed)), key);
			};

			// ---- master + status -------------------------------------------------
			const master = h("div", { className: styles.group }, [
				h("p", { className: styles.groupTitle }, t("statusTitle")),
				checkbox(t("master"), settings.enabled, (next) => void controller.save({ enabled: next }, true)),
				h("p", { className: styles.hint }, t("masterHint")),
				checkbox(t("subagents"), settings.notifySubagents, (next) => void controller.save({ notifySubagents: next }, true)),
				h("p", { className: styles.hint }, t("subagentsHint")),
				selectRow(t("localeLabel"), settings.locale, [
					{ value: "zh", label: "简体中文" },
					{ value: "en", label: "English" },
				], (next) => void controller.save({ locale: next }, true)),
				h("div", { className: styles.row }, [
					badge(t("statusPlatform") + ": " + status.platform, true),
					badge(t("statusLocal") + ": " + (status.localSupported ? status.localBackend : t("localUnsupported")), status.localSupported),
					badge(t("statusQueueValue", { count: String(status.inFlight || 0) }), true),
					h("button", {
						type: "button",
						className: styles.button,
						disabled: snap.busy !== null,
						onClick: () => void controller.test("all"),
					}, snap.busy === "all" ? t("testing") : t("testAll")),
				]),
				snap.testResult
					? h("p", { className: snap.testResult.ok ? styles.statusOk : styles.statusError, role: "status" },
						snap.testResult.ok ? t("testSent") : t("testFailed", { error: snap.testResult.message }))
					: null,
				snap.saveError ? h("p", { className: styles.statusError, role: "alert" }, t("saveFailed", { error: snap.saveError })) : null,
			]);

			// ---- channels --------------------------------------------------------
			const channelRows = CHANNEL_KEYS.map((id) => {
				const info = statusById[id] || { id, label: id, enabled: false, configured: false };
				const configuredText = info.configured
					? t("configured", { masked: info.masked || "" })
					: (id === "cmcc" && info.enabled && !info.configured && settings.cmcc.keyConfigured ? t("partial") : t("unconfigured"));
				const head = h("div", { className: styles.cardHead }, [
					h("span", { className: styles.cardName }, info.label || id),
					badge(configuredText, info.configured),
					id === "cmcc" && info.connected ? badge(t("connected"), true) : null,
					id === "cmcc" && !info.connected && info.enabled ? badge(t("disconnected"), false) : null,
					h("span", { style: { flex: 1 } }),
					h("button", {
						type: "button",
						className: styles.button,
						disabled: snap.busy !== null,
						onClick: () => void controller.test(id),
					}, snap.busy === id ? t("testing") : t("test")),
					checkbox(t("enabled"), info.enabled, (next) => {
						if (id === "local") void controller.save({ local: { enabled: next } }, true);
						else if (id === "bark") void controller.save({ bark: { enabled: next } }, true);
						else if (id === "cmcc") void controller.save({ cmcc: { enabled: next } }, true);
						else void controller.save({ webhooks: { [id]: { enabled: next } } }, true);
					}),
				]);

				const body = [];
				if (id === "bark") {
					body.push(secretRow({
						label: t("barkUrl"),
						placeholder: info.configured ? configuredText : t("barkUrlPlaceholder"),
						value: draftOf("bark.url", ""),
						onChange: (value) => setDraft("bark.url", value),
						onCommit: () => commitText("bark.url", (value) => (value.trim() ? { bark: { url: value } } : null)),
						saveLabel: t("save"),
						disabled: snap.saving,
					}));
					body.push(h("p", { className: styles.hint }, t("barkUrlHint")));
					body.push(textRow(t("barkGroup"), {
						value: draftOf("bark.group", settings.bark.group),
						onChange: (event) => setDraft("bark.group", event.target.value),
						onBlur: () => commitText("bark.group", (value) => (value.trim() ? { bark: { group: value } } : null)),
						onKeyDown: (event) => { if (event.key === "Enter") commitText("bark.group", (value) => (value.trim() ? { bark: { group: value } } : null)); },
					}));
					body.push(h("p", { className: styles.hint }, t("barkGroupHint")));
					body.push(selectRow(t("barkLevel"), settings.bark.level, BARK_LEVELS.map((level) => ({ value: level, label: level })), (next) => void controller.save({ bark: { level: next } }, true)));
					body.push(textRow(t("barkSound"), {
						value: draftOf("bark.sound", settings.bark.sound),
						onChange: (event) => setDraft("bark.sound", event.target.value),
						onBlur: () => { const raw = drafts["bark.sound"]; if (raw !== undefined) saveField({ bark: { sound: String(raw).trim() } }, "bark.sound"); },
						onKeyDown: (event) => { if (event.key === "Enter") { const raw = drafts["bark.sound"]; if (raw !== undefined) saveField({ bark: { sound: String(raw).trim() } }, "bark.sound"); } },
					}));
					body.push(h("p", { className: styles.hint }, t("barkSoundHint")));
				} else if (id === "cmcc") {
					body.push(secretRow({
						label: t("cmccKey"),
						placeholder: info.masked ? configuredText : t("cmccKeyPlaceholder"),
						value: draftOf("cmcc.apiKey", ""),
						onChange: (value) => setDraft("cmcc.apiKey", value),
						onCommit: () => commitText("cmcc.apiKey", (value) => (value.trim() ? { cmcc: { apiKey: value } } : null)),
						saveLabel: t("save"),
						disabled: snap.saving,
					}));
					body.push(h("p", { className: styles.hint }, t("cmccKeyHint")));
					body.push(textRow(t("cmccTo"), {
						value: draftOf("cmcc.to", ""),
						placeholder: settings.cmcc.to || "",
						onChange: (event) => setDraft("cmcc.to", event.target.value),
						onBlur: () => commitText("cmcc.to", (value) => (value.trim() ? { cmcc: { to: value } } : null)),
						onKeyDown: (event) => { if (event.key === "Enter") commitText("cmcc.to", (value) => (value.trim() ? { cmcc: { to: value } } : null)); },
					}));
					body.push(h("p", { className: styles.hint }, t("cmccToHint")));
					body.push(h("div", { className: styles.row }, [
						h("span", { className: styles.label }, t("cmccServer")),
						h("input", {
							className: styles.input,
							type: "text",
							placeholder: settings.cmcc.serverUrl,
							value: draftOf("cmcc.serverUrl", settings.cmcc.serverUrl),
							onChange: (event) => setDraft("cmcc.serverUrl", event.target.value),
							onBlur: () => commitText("cmcc.serverUrl", (value) => (value.trim() ? { cmcc: { serverUrl: value } } : null)),
						}),
					]));
					body.push(h("p", { className: styles.hint }, t("cmccServerHint")));
					body.push(h("div", { className: styles.row }, [
						h("span", { className: styles.label }, t("cmccUpload")),
						h("input", {
							className: styles.input,
							type: "text",
							value: draftOf("cmcc.uploadUrl", settings.cmcc.uploadUrl),
							onChange: (event) => setDraft("cmcc.uploadUrl", event.target.value),
							onBlur: () => commitText("cmcc.uploadUrl", (value) => (value.trim() ? { cmcc: { uploadUrl: value } } : null)),
						}),
					]));
					body.push(h("div", { className: styles.row }, [
						h("span", { className: styles.label }, t("cmccPrefix")),
						h("input", {
							className: styles.input + " " + styles.num,
							type: "text",
							value: draftOf("cmcc.prefix", settings.cmcc.prefix),
							onChange: (event) => setDraft("cmcc.prefix", event.target.value),
							onBlur: () => commitText("cmcc.prefix", (value) => ({ cmcc: { prefix: value.trim() } })),
						}),
						checkbox(t("cmccSummary"), settings.cmcc.includeSummary, (next) => void controller.save({ cmcc: { includeSummary: next } }, true)),
						h("button", {
							type: "button",
							className: styles.button,
							disabled: snap.busy !== null,
							onClick: () => void controller.probe(),
						}, snap.busy === "probe" ? t("probing") : t("probe")),
					]));
					body.push(h("p", { className: styles.hint }, t("cmccProbeHint")));
					body.push(h("p", { className: styles.groupTitle }, t("cmccMediaTitle")));
					body.push(h("p", { className: styles.hint }, t("cmccMediaHint")));
					body.push(h("div", { className: styles.row }, [
						h("span", { className: styles.label }, t("cmccMediaPath")),
						h("input", {
							className: styles.input,
							type: "text",
							value: mediaPath,
							onChange: (event) => setMediaPath(event.target.value),
						}),
					]));
					body.push(h("div", { className: styles.row }, [
						h("span", { className: styles.label }, t("cmccMediaCaption")),
						h("input", {
							className: styles.input,
							type: "text",
							value: mediaCaption,
							onChange: (event) => setMediaCaption(event.target.value),
						}),
						h("button", {
							type: "button",
							className: styles.button,
							disabled: snap.busy !== null || mediaPath.trim().length === 0,
							onClick: () => void controller.test("cmcc-media", { mediaPath: mediaPath.trim(), caption: mediaCaption }),
						}, snap.busy === "cmcc-media" ? t("testing") : t("cmccMediaSend")),
					]));
				} else if (id === "local") {
					body.push(h("p", { className: styles.hint }, status.localSupported ? t("statusLocal") + ": " + status.localBackend : t("localUnsupported")));
					body.push(checkbox(t("localSound"), settings.local.sound, (next) => void controller.save({ local: { sound: next } }, true)));
				} else {
					body.push(secretRow({
						label: t("webhookUrl"),
						placeholder: info.configured ? configuredText : "https://...",
						value: draftOf("hook." + id, ""),
						onChange: (value) => setDraft("hook." + id, value),
						onCommit: () => commitText("hook." + id, (value) => (value.trim() ? { webhooks: { [id]: { url: value } } } : null)),
						saveLabel: t("save"),
						disabled: snap.saving,
					}));
					body.push(h("p", { className: styles.hint }, t("webhookUrlHint")));
					body.push(checkbox(t("webhookSummary"), settings.webhooks[id] ? settings.webhooks[id].includeSummary : false, (next) => void controller.save({ webhooks: { [id]: { includeSummary: next } } }, true)));

					// Provider-side bot security (飞书: 自定义关键词 / 签名校验). Only the
					// channels whose provider supports a control get it rendered.
					if (SECURITY_CHANNELS[id]) {
						const hook = settings.webhooks[id] || {};
						body.push(h("p", { className: styles.groupTitle }, t("webhookSecurityTitle")));
						body.push(textRow(t("webhookKeyword"), {
							value: draftOf("hookkw." + id, hook.keyword || ""),
							placeholder: t("webhookKeywordPlaceholder"),
							onChange: (event) => setDraft("hookkw." + id, event.target.value),
							onBlur: () => {
								const raw = drafts["hookkw." + id];
								if (raw === undefined) return;
								// An empty keyword is meaningful here: it switches the check off.
								saveField({ webhooks: { [id]: { keyword: String(raw).trim() } } }, "hookkw." + id);
							},
							onKeyDown: (event) => {
								if (event.key !== "Enter") return;
								const raw = drafts["hookkw." + id];
								if (raw !== undefined) saveField({ webhooks: { [id]: { keyword: String(raw).trim() } } }, "hookkw." + id);
							},
						}));
						body.push(h("p", { className: styles.hint }, t("webhookKeywordHint")));
						body.push(secretRow({
							label: t("webhookSecret"),
							placeholder: hook.secretConfigured
								? t("configured", { masked: hook.secretMasked || "" })
								: t("webhookSecretPlaceholder"),
							value: draftOf("hooksec." + id, ""),
							onChange: (value) => setDraft("hooksec." + id, value),
							onCommit: () => commitText("hooksec." + id, (value) => (value.trim() ? { webhooks: { [id]: { secret: value } } } : null)),
							saveLabel: t("save"),
							disabled: snap.saving,
						}));
						body.push(h("p", { className: styles.hint }, t("webhookSecretHint")));
					}
				}

				return h("div", { key: id, className: styles.card }, [head, ...body.filter(Boolean)]);
			});

			const channels = h("div", { className: styles.group }, [
				h("p", { className: styles.groupTitle }, t("channelsTitle")),
				h("p", { className: styles.hint }, t("channelsHint")),
				...channelRows,
			]);

			// ---- events ----------------------------------------------------------
			const events = h("div", { className: styles.group }, [
				h("p", { className: styles.groupTitle }, t("eventsTitle")),
				h("p", { className: styles.hint }, t("eventsHint")),
				h("div", { className: styles.grid }, EVENT_KEYS.map((key) => h("span", { key },
					checkbox(t("event." + key), settings.events[key], (next) => {
						const nextEvents = Object.assign({}, settings.events, { [key]: next });
						void controller.save({ events: nextEvents }, true);
					}),
				))),
			]);

			// ---- content ---------------------------------------------------------
			const content = h("div", { className: styles.group }, [
				h("p", { className: styles.groupTitle }, t("contentTitle")),
				checkbox(t("includeAssistant"), settings.includeAssistantText, (next) => void controller.save({ includeAssistantText: next }, true)),
				h("p", { className: styles.hint }, t("includeAssistantHint")),
				numberRow(t("maxBodyChars"), {
					min: 40,
					max: 4000,
					value: draftOf("maxBodyChars", settings.maxBodyChars),
					onChange: (event) => setDraft("maxBodyChars", event.target.value),
					onBlur: () => commitNumber("maxBodyChars", (value) => ({ maxBodyChars: Math.min(4000, Math.max(40, value)) })),
				}),
				numberRow(t("historyLimit"), {
					min: 0,
					max: 500,
					value: draftOf("historyLimit", settings.historyLimit),
					onChange: (event) => setDraft("historyLimit", event.target.value),
					onBlur: () => commitNumber("historyLimit", (value) => ({ historyLimit: Math.min(500, Math.max(0, value)) })),
				}),
				h("p", { className: styles.hint }, t("historyLimitHint")),
			]);

			// ---- rules -----------------------------------------------------------
			const saveRules = (rules) => void controller.save({ rules }, true);
			const rules = h("div", { className: styles.group }, [
				h("p", { className: styles.groupTitle }, t("rulesTitle")),
				h("p", { className: styles.hint }, t("rulesHint")),
				...(settings.rules || []).map((rule, index) => h("div", { key: "r" + index, className: styles.row }, [
					h("select", {
						className: styles.select,
						value: rule.mode,
						onChange: (event) => {
							const next = settings.rules.map((entry, at) => (at === index ? Object.assign({}, entry, { mode: event.target.value }) : entry));
							saveRules(next);
						},
					}, [
						h("option", { key: "include", value: "include" }, t("ruleInclude")),
						h("option", { key: "exclude", value: "exclude" }, t("ruleExclude")),
					]),
					h("input", {
						className: styles.input,
						type: "text",
						placeholder: t("rulePattern"),
						value: draftOf("rule." + index, rule.pattern),
						onChange: (event) => setDraft("rule." + index, event.target.value),
						onBlur: () => {
							const raw = drafts["rule." + index];
							if (raw === undefined) return;
							clearDraft("rule." + index);
							if (String(raw).trim().length === 0) return;
							saveRules(settings.rules.map((entry, at) => (at === index ? Object.assign({}, entry, { pattern: String(raw) }) : entry)));
						},
					}),
					checkbox(t("ruleRegex"), rule.regex, (next) => saveRules(settings.rules.map((entry, at) => (at === index ? Object.assign({}, entry, { regex: next }) : entry)))),
					checkbox(t("ruleCase"), rule.caseSensitive, (next) => saveRules(settings.rules.map((entry, at) => (at === index ? Object.assign({}, entry, { caseSensitive: next }) : entry)))),
					h("button", {
						type: "button",
						className: styles.button,
						onClick: () => saveRules(settings.rules.filter((entry, at) => at !== index)),
					}, t("ruleRemove")),
				])),
				h("button", {
					type: "button",
					className: styles.button,
					onClick: () => saveRules([...(settings.rules || []), { mode: "include", pattern: " ", regex: false, caseSensitive: false }]),
				}, t("ruleAdd")),
			]);

			// ---- routes ----------------------------------------------------------
			const saveRoutes = (routes) => void controller.save({ routes }, true);
			const routes = h("div", { className: styles.group }, [
				h("p", { className: styles.groupTitle }, t("routesTitle")),
				h("p", { className: styles.hint }, t("routesHint")),
				...(settings.routes || []).map((route, index) => h("div", { key: "t" + index, className: styles.card }, [
					h("div", { className: styles.row }, [
						h("input", {
							className: styles.input,
							type: "text",
							placeholder: t("routePattern"),
							value: draftOf("route." + index, route.pattern),
							onChange: (event) => setDraft("route." + index, event.target.value),
							onBlur: () => {
								const raw = drafts["route." + index];
								if (raw === undefined) return;
								clearDraft("route." + index);
								if (String(raw).trim().length === 0) return;
								saveRoutes(settings.routes.map((entry, at) => (at === index ? Object.assign({}, entry, { pattern: String(raw) }) : entry)));
							},
						}),
						checkbox(t("ruleRegex"), route.regex, (next) => saveRoutes(settings.routes.map((entry, at) => (at === index ? Object.assign({}, entry, { regex: next }) : entry)))),
						h("button", {
							type: "button",
							className: styles.button,
							onClick: () => saveRoutes(settings.routes.filter((entry, at) => at !== index)),
						}, t("ruleRemove")),
					]),
					h("div", { className: styles.row }, [
						h("span", { className: styles.label }, t("routeChannels")),
						...CHANNEL_KEYS.map((id) => {
							const on = (route.channels || []).indexOf(id) >= 0;
							return h("button", {
								key: id,
								type: "button",
								className: styles.chip + (on ? " " + styles.chipOn : ""),
								onClick: () => {
									const current = route.channels || [];
									const nextChannels = on ? current.filter((value) => value !== id) : [...current, id];
									saveRoutes(settings.routes.map((entry, at) => (at === index ? Object.assign({}, entry, { channels: nextChannels }) : entry)));
								},
							}, ((statusById[id] || {}).label) || id);
						}),
					]),
				])),
				h("button", {
					type: "button",
					className: styles.button,
					onClick: () => saveRoutes([...(settings.routes || []), { pattern: " ", regex: false, caseSensitive: false, channels: [] }]),
				}, t("routeAdd")),
			]);

			// ---- history ---------------------------------------------------------
			const history = h("div", { className: styles.group }, [
				h("div", { className: styles.row + " " + styles.between }, [
					h("p", { className: styles.groupTitle }, t("historyTitle")),
					h("button", { type: "button", className: styles.button, onClick: () => void controller.clearHistory() }, t("historyClear")),
				]),
				h("p", { className: styles.hint }, t("historyHint", { count: String((snap.history || []).length) })),
				(snap.history || []).length === 0
					? h("p", { className: styles.hint }, t("historyEmpty"))
					: h("div", { className: styles.history }, (snap.history || []).slice(0, 50).map((entry, index) => h("div", {
						key: "h" + index,
						className: styles.historyRow,
					}, [
						h("span", { className: styles.mono }, formatTime(entry.time)),
						badge(entry.channel, entry.ok),
						h("span", { className: entry.ok ? styles.statusOk : styles.statusError }, entry.ok ? t("historyOk") : t("historyFail")),
						h("span", null, entry.title || ""),
						h("span", { className: styles.hint }, entry.kind || ""),
						entry.error ? h("span", { className: styles.statusError }, entry.error) : null,
					]))),
			]);

			return h("div", { className: styles.section }, [
				h("h2", { className: styles.heading }, t("title")),
				h("p", { className: styles.intro }, t("intro")),
				master,
				channels,
				events,
				content,
				rules,
				routes,
				history,
			]);
		}
		//#endregion

		//#region dsh-notify-hub: plugin entry
		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale", "connection"];

		/**
		 * Register the hub dictionaries and the settings section.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-notify-hub: dictionaries");

			ctx.inject(["slots", "locale", "connection"], (scope) => {
				const controller = new HubSectionController(scope.get("connection"));
				const t = scope.locale.bind(NS);
				const injected = () => ({ controller, t, hooks: { snapshot: controller.store } });

				scope.slots.inject("settings.section", () => scope.slots.register({
					name: "settings.section",
					id: "notify-hub",
					order: 45,
					label: () => t("nav"),
					inject: injected,
				}, HubSettingsSection));
			});
		}
		//#endregion

		exports.HubSectionController = HubSectionController;
		exports.HubSettingsSection = HubSettingsSection;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
