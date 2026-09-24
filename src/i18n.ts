/**
 * Auto Approve — i18n (en / zh).
 *
 * User-facing strings only.  The judge prompt is intentionally English-only
 * (it is model-facing, not user-facing) and lives in judge.ts.
 * `format(key, ...args)` substitutes `{0}`, `{1}`, … in order; an absent
 * argument leaves the placeholder untouched so parity tests can diff them.
 */

export type I18nLang = "en" | "zh";

interface Dictionary {
  help: string;
  cmdDescription: string;
  statusEnabled: string;
  statusDisabled: string;
  switchEnabled: string;
  switchDisabled: string;
  switchDisplay: string;
  switchRisk: string;
  notifyApproved: string;
  notifyBlocked: string;
  markerApproved: string;
  markerBlocked: string;
  reasonFallback: string;
  reasonDeny: string;
  reasonHighRisk: string;
  reasonMediumRisk: string;
  reasonTruncated: string;
  reasonNoVerdict: string;
  riskLow: string;
  riskMedium: string;
  riskHigh: string;
  blocked: string;
  deniedJudgeDeclined: string;
  deniedJudgeRisk: string;
  deniedJudgeUnavailable: string;
  deniedNoVerdict: string;
  deniedTooLong: string;
  deniedUserDenied: string;
  headlessNote: string;
  analyzing: string;
  cmdOnDescription: string;
  cmdOffDescription: string;
  cmdStatusDescription: string;
  cmdDisplayDescription: string;
  cmdRiskDescription: string;
  cmdDisplayOffDescription: string;
  cmdDisplayMarkerDescription: string;
  cmdDisplayBothDescription: string;
  cmdRiskMediumDescription: string;
  cmdRiskHighDescription: string;
  cmdFallbackDescription: string;
  cmdFallbackAskDescription: string;
  cmdFallbackBlockDescription: string;
  fallbackStatus: string;
  fallbackSwitched: string;
  displayStatus: string;
  riskStatus: string;
  confirmTitle: string;
  allowPrompt: string;
  commandLabel: string;
  analysisUnavailable: string;
  userDenied: string;
  riskUser: string;
  riskDeep: string;
}

const EN: Dictionary = {
  help: [
    "auto-approve — judge-model auto-approval for bash",
    "",
    "usage: /auto-approve [on|off|status|display <off|marker|both>|risk <medium|high>|fallback <ask|block>]",
    "",
    "  (no argument)         toggle enabled and show current settings",
    "  on | off              enable / disable (persisted)",
    "  status                show current settings",
    "  display                show where auto-approval is shown",
    "  display <off|marker|both>  where auto-approval is shown (persisted)",
    "  risk                   show the block risk level",
    "  risk <medium|high>    block risk level (persisted)",
    "  fallback <ask|block>  policy when the risk threshold is crossed (persisted)",
  ].join("\n"),
  cmdDescription: "Auto-approve low-risk operations with a judge model",
  statusEnabled: "auto-approve: ON (model {0}, display {1}, blocks risk {2} and above)",
  statusDisabled: "auto-approve: OFF (bash passes through natively)",
  switchEnabled: "auto-approve enabled.",
  switchDisabled: "auto-approve disabled.",
  switchDisplay: "display set to {0}.",
  switchRisk: "block risk set to {0}.",
  notifyApproved: "✅ Auto-approved — {0}{1}",
  notifyBlocked: "❌ Auto-approve blocked: {0}",
  markerApproved: "auto-approve: approved — {0}{1}",
  markerBlocked: "auto-approve: blocked ({0})",
  reasonFallback: "judge unavailable",
  reasonDeny: "judge declined",
  reasonHighRisk: "high risk",
  reasonMediumRisk: "medium risk",
  reasonTruncated: "too long to assess in full",
  reasonNoVerdict: "no usable verdict",
  riskLow: "low risk",
  riskMedium: "medium risk",
  riskHigh: "high risk",
  blocked: "auto-approve: {0} — the command was not executed",
  deniedJudgeDeclined: "The judge model reviewed this command and declined it{0}. Nothing was executed. Do not retry the same command; use a safer alternative.",
  deniedJudgeRisk: "The judge model rated this command {0}{1}. Nothing was executed. Do not retry the same command; use a safer alternative.",
  deniedJudgeUnavailable: "The judge model could not be consulted ({0}), so this command was blocked by the fail-closed default. Nothing was executed; the command was not assessed as dangerous. Retry once the judge is available, or use a clearly safe command.",
  deniedNoVerdict: "The judge model responded but did not produce a usable risk verdict, so this command was blocked by the fail-closed default. Nothing was executed. Retry the assessment, or use a clearly safe command.",
  deniedTooLong: "This command is {0} characters long; the judge can only assess the first {1}, so it was blocked by the fail-closed default. Nothing was executed. Split it into shorter commands so each one can be fully assessed.",
  deniedUserDenied: "You declined this command in the review dialog. Nothing was executed. Do not re-run the same command without a new reason justifying it.",
  headlessNote: " This session is headless (no user interface), so no confirmation dialog was shown.",
  analyzing: "👀 Reviewing command with judge model…",
  cmdOnDescription: "enable auto-approve",
  cmdOffDescription: "disable auto-approve",
  cmdStatusDescription: "show current settings",
  cmdDisplayDescription: "set where approval markers appear (off|marker|both)",
  cmdRiskDescription: "set the block risk level (medium|high)",
  cmdDisplayOffDescription: "no markers at all",
  cmdDisplayMarkerDescription: "tool-card line only",
  cmdDisplayBothDescription: "tool-card line and chat toast",
  cmdRiskMediumDescription: "block medium and high risk",
  cmdRiskHighDescription: "block high risk only",
  cmdFallbackDescription: "set the policy when the risk threshold is crossed (ask|block)",
  cmdFallbackAskDescription: "ask the user with the deep-analysis summary",
  cmdFallbackBlockDescription: "block without asking",
  fallbackStatus: "fallback policy: {0}",
  fallbackSwitched: "fallback policy set to {0}.",
  displayStatus: "display mode: {0}",
  riskStatus: "block risk: {0}",
  confirmTitle: "⚠️ Dangerous command review",
  allowPrompt: "Allow execution?",
  commandLabel: "Command",
  analysisUnavailable: "risk analysis unavailable",
  userDenied: "user denied",
  riskUser: "user",
  riskDeep: "deep review",
};

const ZH: Dictionary = {
  help: [
    "auto-approve — 使用裁判模型自动审批 bash 命令",
    "",
    "用法: /auto-approve [on|off|status|display <off|marker|both>|risk <medium|high>|fallback <ask|block>]",
    "",
    "  (不带参数)           切换启用状态并显示当前配置",
    "  on | off             启用 / 停用(会持久化)",
    "  status               显示当前配置",
    "  display                显示自动审批的展示位置",
    "  display <off|marker|both>  自动审批的展示位置(会持久化)",
    "  risk                   显示拦截的风险等级",
    "  risk <medium|high>   拦截的风险等级(会持久化)",
    "  fallback <ask|block> 风险阈值被越过时的策略(会持久化)",
  ].join("\n"),
  cmdDescription: "使用裁判模型自动批准低风险操作",
  statusEnabled: "auto-approve: 已启用(模型 {0},展示 {1},拦截风险 {2} 及以上)",
  statusDisabled: "auto-approve: 已停用(bash 原生通过)",
  switchEnabled: "已启用 auto-approve。",
  switchDisabled: "已停用 auto-approve。",
  switchDisplay: "展示方式已设为 {0}。",
  switchRisk: "拦截风险等级已设为 {0}。",
  notifyApproved: "✅ 自动批准 — {0}{1}",
  notifyBlocked: "❌ auto-approve 已拦截: {0}",
  markerApproved: "auto-approve: 已批准 — {0}{1}",
  markerBlocked: "auto-approve: 已拦截({0})",
  reasonFallback: "裁判不可用",
  reasonDeny: "裁判拒绝",
  reasonHighRisk: "高风险",
  reasonMediumRisk: "中风险",
  reasonTruncated: "过长,无法完整评估",
  reasonNoVerdict: "无可用的风险判定",
  riskLow: "低风险",
  riskMedium: "中风险",
  riskHigh: "高风险",
  blocked: "auto-approve: {0} — 该命令未执行",
  deniedJudgeDeclined: "裁判模型审查了该命令并拒绝了它{0}。未执行任何内容。不要重试相同命令;请改用更安全的替代方案。",
  deniedJudgeRisk: "裁判模型将该命令评为{0}{1}。未执行任何内容。不要重试相同命令;请改用更安全的替代方案。",
  deniedJudgeUnavailable: "无法咨询裁判模型({0}),因此按 fail-closed 默认策略拦截了该命令。未执行任何内容;该命令未被评估为危险。请在裁判可用后重试,或改用明显安全的命令。",
  deniedNoVerdict: "裁判模型有响应,但未给出可用的风险判定,因此按 fail-closed 默认策略拦截了该命令。未执行任何内容。请重试评估,或改用明显安全的命令。",
  deniedTooLong: "该命令长达 {0} 个字符;裁判只能评估前 {1} 个字符,因此按 fail-closed 默认策略拦截了该命令。未执行任何内容。请拆分为更短的命令,使每条命令都能被完整评估。",
  deniedUserDenied: "您在确认对话框中拒绝了该命令。未执行任何内容。除非有新的依据,不要重新运行相同命令。",
  headlessNote: "此会话为无界面(headless)会话,未弹出确认对话框。",
  analyzing: "👀 正在使用裁判模型审查命令…",
  cmdOnDescription: "启用 auto-approve",
  cmdOffDescription: "停用 auto-approve",
  cmdStatusDescription: "显示当前配置",
  cmdDisplayDescription: "设置展示位置 (off|marker|both)",
  cmdRiskDescription: "设置拦截的风险等级 (medium|high)",
  cmdDisplayOffDescription: "不展示任何标记",
  cmdDisplayMarkerDescription: "仅工具卡片标记",
  cmdDisplayBothDescription: "工具卡片标记与聊天提示",
  cmdRiskMediumDescription: "拦截中、高风险",
  cmdRiskHighDescription: "仅拦截高风险",
  cmdFallbackDescription: "设置风险阈值被越过时的策略 (ask|block)",
  cmdFallbackAskDescription: "用深度分析摘要询问用户",
  cmdFallbackBlockDescription: "不询问,直接拦截",
  fallbackStatus: "回退策略: {0}",
  fallbackSwitched: "回退策略已设为 {0}。",
  displayStatus: "展示方式: {0}",
  riskStatus: "拦截风险等级: {0}",
  confirmTitle: "⚠️ 危险命令确认",
  allowPrompt: "是否允许执行？",
  commandLabel: "命令",
  analysisUnavailable: "风险评估不可用",
  userDenied: "用户拒绝",
  riskUser: "用户",
  riskDeep: "深度审查",
};

const DICTIONARIES: Record<I18nLang, Dictionary> = { en: EN, zh: ZH };

export class I18n {
  readonly lang: I18nLang;
  private readonly dict: Dictionary;

  constructor(lang: I18nLang) {
    this.lang = lang;
    this.dict = DICTIONARIES[lang];
  }

  /** All keys in this locale (used by the parity test). */
  keys(): string[] {
    return Object.keys(this.dict);
  }

  /** Format a localized string, substituting {0}, {1}, … with the args.
   *  Missing args leave the placeholder in place; unknown keys pass
   *  through untouched. */
  format(key: string, ...args: string[]): string {
    const template = key in this.dict ? this.dict[key as keyof Dictionary] : key;
    return template.replace(/\{(\d+)\}/g, (match, n) => {
      const value = args[Number(n)];
      return value === undefined ? match : value;
    });
  }
}

/** Detect the UI locale from LC_ALL / LANG (zh* → zh, everything else → en). */
export function detectLang(): I18nLang {
  const env = process.env.LC_ALL || process.env.LANG || "";
  return env.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function createI18n(lang?: I18nLang): I18n {
  return new I18n(lang ?? detectLang());
}