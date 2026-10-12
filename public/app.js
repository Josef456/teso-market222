(function () {
  var t; try { t = localStorage.getItem('theme'); } catch (e) {}
  if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('theme').onclick = function () {
      var n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = n; try { localStorage.setItem('theme', n); } catch (e) {}
    };
    document.getElementById('menu').onclick = function () { document.getElementById('links').classList.toggle('open'); };
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { threshold: .12 });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  });
})();
