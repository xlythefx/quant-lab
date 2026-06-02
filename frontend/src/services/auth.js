const KEY = "ql.auth";
export const isAuthenticated = () => localStorage.getItem(KEY) === "1";
export const login  = () => localStorage.setItem(KEY, "1");
export const logout = () => localStorage.removeItem(KEY);
