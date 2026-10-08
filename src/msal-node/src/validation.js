// Java 版 / Floodgate(Bedrock) の名前を許容する。長さは安全側に 20 文字まで。
const MC_NAME_RE = /^[A-Za-z0-9_.]{1,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^\d{6}$/;

const isMcName = (v) => typeof v === 'string' && MC_NAME_RE.test(v);
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isLoginCode = (v) => typeof v === 'string' && CODE_RE.test(v);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = { isMcName, isUuid, isLoginCode, escapeHtml };
