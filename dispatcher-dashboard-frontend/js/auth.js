(function () {
  const LOGIN = "/dashboard/login.html";

  function isExpired(token) {
    try {
      return Date.now() / 1000 > JSON.parse(atob(token.split(".")[1])).exp;
    } catch {
      return true;
    }
  }

  function doLogout() {
    localStorage.removeItem("adminToken");
    localStorage.removeItem("adminShop");
    window.location.replace(LOGIN);
  }

  window.logout = doLogout;

  window.requireAuth = function () {
    const t = localStorage.getItem("adminToken");
    if (!t || isExpired(t)) window.location.replace(LOGIN);
  };

  // Bind logout button via addEventListener as soon as the DOM is ready,
  // so it works regardless of inline onclick availability.
  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.querySelector(".btn-logout");
    if (btn) btn.addEventListener("click", doLogout);
  });
})();
