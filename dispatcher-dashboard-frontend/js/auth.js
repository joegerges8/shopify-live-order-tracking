(function () {
  const LOGIN = "/dashboard/login.html";

  function isExpired(token) {
    try {
      return Date.now() / 1000 > JSON.parse(atob(token.split(".")[1])).exp;
    } catch {
      return true;
    }
  }

  window.logout = function () {
    localStorage.removeItem("adminToken");
    location.href = LOGIN;
  };

  window.requireAuth = function () {
    const t = localStorage.getItem("adminToken");
    if (!t || isExpired(t)) location.replace(LOGIN);
  };
})();
