// Best-effort localStorage (private mode / blocked storage must not break the app).
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem('m5sq.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('m5sq.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem('m5sq.' + k); } catch { /* ignore */ } },
};
