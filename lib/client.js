/**
 * dsh-patch-sync —— 浏览器半：轮询宿主状态，在右下角提示"已自动恢复补丁"或
 * "上游文件冲突（已保留原文件）"。
 *
 * 纯 DOM 实现（不依赖 React/插槽服务），刻意做得很小：即使 web shell 的
 * 某个服务缺失，也只会少一个提示卡，不会影响 DSH 启动。
 */
window.__ModuleLoader__.load({
	id: "dsh-patch-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var NS = "dsh-patch-sync";
		var STATE = {
			timer: undefined,
			card: undefined,
			hiddenEventId: 0,
			hideTimer: undefined,
			closed: false,
		};

		function api(path, options) {
			return fetch(path, Object.assign({ cache: "no-store" }, options || {})).then(function (response) {
				return response.ok ? response.json() : undefined;
			}).catch(function () { return undefined; });
		}

		function ensureStyles() {
			if (document.getElementById("dsh-patch-sync-styles") !== null) return;
			var style = document.createElement("style");
			style.id = "dsh-patch-sync-styles";
			style.textContent = [
				".dsh-patch-sync-card{position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:min(460px,calc(100vw - 32px));",
				"background:#1f2127;color:#e6e8ee;border:1px solid rgba(127,127,127,.4);border-radius:10px;",
				"box-shadow:0 10px 30px rgba(0,0,0,.45);padding:12px 14px;font:12px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;cursor:default}",
				".dsh-patch-sync-card.is-conflict{border-color:rgba(230,158,60,.45)}",
				".dsh-patch-sync-card.is-error{border-color:rgba(255,120,100,.45)}",
				".dsh-patch-sync-title{font-weight:600;margin-bottom:6px}",
				".dsh-patch-sync-body{white-space:pre-wrap;opacity:.92}",
				".dsh-patch-sync-list{margin:6px 0 0;padding-left:16px;opacity:.85;max-height:120px;overflow:auto}",
				".dsh-patch-sync-actions{display:flex;gap:8px;margin-top:10px;justify-content:flex-end}",
				".dsh-patch-sync-btn{border:none;border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer;background:rgba(127,127,127,.2);color:inherit}",
				".dsh-patch-sync-btn:hover{background:rgba(127,127,127,.32)}",
				".dsh-patch-sync-hint{opacity:.55;margin-top:6px;font-size:11px;word-break:break-all}",
			].join("");
			(document.head || document.documentElement).appendChild(style);
		}

		function removeCard() {
			if (STATE.hideTimer !== undefined) {
				clearTimeout(STATE.hideTimer);
				STATE.hideTimer = undefined;
			}
			if (STATE.card !== undefined && STATE.card.parentNode) {
				STATE.card.parentNode.removeChild(STATE.card);
			}
			STATE.card = undefined;
		}

		function dismiss() {
			var eventId = STATE.hiddenEventId;
			removeCard();
			api("/dsh-patch-sync/dismiss", { method: "POST" }).then(function (status) {
				if (status && Number.isFinite(status.eventId)) STATE.hiddenEventId = status.eventId;
			});
			// 记录本地已读，避免轮询把正在展示的事件又弹出来。
			STATE.hiddenEventId = Math.max(STATE.hiddenEventId, eventId);
		}

		function render(status) {
			if (STATE.closed || !status) return;
			var event = status.lastEvent;
			if (!event) return;
			var isConflict = event.kind === "conflict";
			var isError = event.kind === "error";
			var isRestored = event.kind === "restored";
			if (!isConflict && !isError && !isRestored) return;
			if (event.id <= STATE.hiddenEventId) return;
			if (event.id <= (status.dismissedEventId || 0)) {
				STATE.hiddenEventId = Math.max(STATE.hiddenEventId, event.id);
				return;
			}

			ensureStyles();
			removeCard();
			var card = document.createElement("div");
			card.className = "dsh-patch-sync-card" + (isConflict ? " is-conflict" : isError ? " is-error" : "");
			var title = document.createElement("div");
			title.className = "dsh-patch-sync-title";
			title.textContent = isConflict ? "补丁同步：上游冲突" : isError ? "补丁同步：失败" : "补丁同步：已恢复补丁";
			card.appendChild(title);

			var body = document.createElement("div");
			body.className = "dsh-patch-sync-body";
			body.textContent = event.message || "";
			card.appendChild(body);

			if (isConflict && Array.isArray(event.conflictsAdded) && event.conflictsAdded.length > 0) {
				var list = document.createElement("ul");
				list.className = "dsh-patch-sync-list";
				event.conflictsAdded.slice(0, 8).forEach(function (item) {
					var li = document.createElement("li");
					li.textContent = (event.plugin || "") + " → " + item.path;
					list.appendChild(li);
				});
				card.appendChild(list);
			}

			var hint = document.createElement("div");
			hint.className = "dsh-patch-sync-hint";
			hint.textContent = "报告：~/.dsh/patch-sync/reports/latest.md · 记录：~/.dsh/patch-sync/records/";
			card.appendChild(hint);

			var actions = document.createElement("div");
			actions.className = "dsh-patch-sync-actions";
			var dismissButton = document.createElement("button");
			dismissButton.type = "button";
			dismissButton.className = "dsh-patch-sync-btn";
			dismissButton.textContent = "知道了";
			dismissButton.onclick = function () {
				STATE.hiddenEventId = event.id;
				dismiss();
			};
			actions.appendChild(dismissButton);
			card.appendChild(actions);

			document.body.appendChild(card);
			STATE.card = card;
			STATE.hiddenEventId = Math.max(STATE.hiddenEventId, event.id);
			if (isRestored) {
				STATE.hideTimer = setTimeout(removeCard, 10000);
			}
		}

		function poll() {
			if (STATE.closed) return;
			api("/dsh-patch-sync/status").then(render).catch(function () {});
		}

		function apply() {
			try {
				if (typeof document === "undefined") return;
				var start = function () {
					ensureStyles();
					setTimeout(poll, 3000);
					STATE.timer = setInterval(poll, 5000);
				};
				if (document.body) start();
				else setTimeout(start, 1000);
			} catch (error) {
				try { console.warn("[dsh-patch-sync] client init failed", error); } catch {}
			}
		}

		exports.NS = NS;
		exports.inject = [];
		exports.apply = apply;
		return module.exports;
	}
});
