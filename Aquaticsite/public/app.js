(function () {
  'use strict';

  /* ------------------------------------------------------------------
     Состояние и вспомогательные функции
     ------------------------------------------------------------------ */
  var TOKEN_KEY = 'aquatic_token';
  var state = { user: null, roles: [], canGrantAdmin: false };

  function $(id) { return document.getElementById(id); }

  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
  function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') Object.keys(v).forEach(function (s) { node.style.setProperty(s, v[s]); });
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name, cls) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function api(method, path, body) {
    var headers = { 'Content-Type': 'application/json' };
    var t = getToken();
    if (t) headers.Authorization = 'Bearer ' + t;
    return fetch('/api' + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .catch(function () { throw new Error('Не удалось связаться с сервером. Проверьте соединение.'); })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (r.status === 401 && t) { clearToken(); state.user = null; renderNav(); }
          if (!r.ok) {
            var err = new Error(data.message || ('Ошибка сервера (' + r.status + ')'));
            err.status = r.status;
            throw err;
          }
          return data;
        });
      });
  }

  function setMsg(id, text, kind) {
    var node = $(id);
    node.textContent = text || '';
    node.className = 'msg' + (kind ? ' ' + kind : '');
  }

  /* ------------------------------------------------------------------
     Плавное появление блоков при прокрутке
     ------------------------------------------------------------------ */
  (function initReveal() {
    var items = document.querySelectorAll('.reveal');
    function show(node) {
      node.classList.add('in');
      setTimeout(function () { node.style.setProperty('--d', '0ms'); }, 1200);
    }
    if (!('IntersectionObserver' in window)) { items.forEach(show); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { show(e.target); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    items.forEach(function (n) { io.observe(n); });
  })();

  /* ------------------------------------------------------------------
     Шапка: кто вошёл
     ------------------------------------------------------------------ */
  function renderNav() {
    var u = state.user;
    $('authBtn').hidden = !!u;
    $('userBox').hidden = !u;
    $('adminBtn').hidden = !(u && u.isAdmin);
    if (u) {
      $('userNick').textContent = u.nick;
      $('userNick').style.color = u.role.color;
      var badge = $('userRole');
      badge.textContent = u.role.name;
      badge.style.setProperty('--c', u.role.color);
    }
  }
  function refreshMe() {
    if (!getToken()) { state.user = null; renderNav(); return Promise.resolve(); }
    return api('GET', '/me').then(function (d) { state.user = d.user; renderNav(); })
      .catch(function () { renderNav(); });
  }

  /* ------------------------------------------------------------------
     Окно входа / регистрации
     ------------------------------------------------------------------ */
  var dlg = $('auth');
  var forms = { login: $('formLogin'), register: $('formRegister') };
  var tabs = { login: $('tabLogin'), register: $('tabRegister') };
  var copy = {
    login: { title: 'Добро пожаловать', hint: 'Войдите, чтобы открыть возможности клиента.',
             sw: 'Нет аккаунта? <button type="button" data-tab="register">Зарегистрируйтесь</button>' },
    register: { title: 'Создайте аккаунт', hint: 'Это займёт минуту. Ник должен совпадать с ником в игре.',
                sw: 'Уже есть аккаунт? <button type="button" data-tab="login">Войдите</button>' }
  };

  function openDialog(d) {
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  function closeDialog(d) {
    if (typeof d.close === 'function') d.close(); else d.removeAttribute('open');
  }
  function setTab(name) {
    ['login', 'register'].forEach(function (k) {
      var active = k === name;
      tabs[k].setAttribute('aria-selected', active ? 'true' : 'false');
      forms[k].hidden = !active;
    });
    $('authTitle').textContent = copy[name].title;
    $('authHint').textContent = copy[name].hint;
    $('switchLine').innerHTML = copy[name].sw;
    setMsg('loginMsg', '');
    setMsg('regMsg', '');
  }
  function openAuth(name) {
    setTab(name || 'login');
    openDialog(dlg);
    var first = forms[name || 'login'].querySelector('input');
    if (first) first.focus();
  }

  function busy(form, on) { form.querySelector('button[type="submit"]').disabled = on; }

  function finishAuth(data, msgId) {
    setToken(data.token);
    state.user = data.user;
    renderNav();
    setMsg(msgId, 'Готово! Вы вошли в аккаунт.', 'ok');
    setTimeout(function () { closeDialog(dlg); forms.login.reset(); forms.register.reset(); }, 700);
  }

  forms.login.addEventListener('submit', function (e) {
    e.preventDefault();
    var login = $('loginName').value.trim();
    var pass = $('loginPass').value;
    if (!login) return setMsg('loginMsg', 'Введите ник или почту.', 'err');
    if (!pass) return setMsg('loginMsg', 'Введите пароль.', 'err');
    setMsg('loginMsg', '');
    busy(forms.login, true);
    api('POST', '/login', { login: login, password: pass })
      .then(function (d) { finishAuth(d, 'loginMsg'); })
      .catch(function (err) { setMsg('loginMsg', err.message, 'err'); })
      .then(function () { busy(forms.login, false); });
  });

  forms.register.addEventListener('submit', function (e) {
    e.preventDefault();
    var nick = $('regNick').value.trim();
    var mail = $('regMail').value.trim();
    var p1 = $('regPass').value;
    var p2 = $('regPass2').value;
    if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) return setMsg('regMsg', 'Ник: от 3 до 16 символов, только латиница, цифры и _.', 'err');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return setMsg('regMsg', 'Проверьте адрес почты.', 'err');
    if (p1.length < 8) return setMsg('regMsg', 'Пароль должен быть не короче 8 символов.', 'err');
    if (p1 !== p2) return setMsg('regMsg', 'Пароли не совпадают.', 'err');
    setMsg('regMsg', '');
    busy(forms.register, true);
    api('POST', '/register', { nick: nick, email: mail, password: p1 })
      .then(function (d) { finishAuth(d, 'regMsg'); })
      .catch(function (err) { setMsg('regMsg', err.message, 'err'); })
      .then(function () { busy(forms.register, false); });
  });

  $('logoutBtn').addEventListener('click', function () {
    api('POST', '/logout').catch(function () {}).then(function () {
      clearToken(); state.user = null; renderNav();
      if ($('adminDlg').open) closeDialog($('adminDlg'));
    });
  });

  /* ------------------------------------------------------------------
     Админ-панель
     ------------------------------------------------------------------ */
  var adminDlg = $('adminDlg');
  var SWATCHES = ['#FF5D5D', '#FFA94D', '#FFD43B', '#69DB7C', '#4CC3F2', '#748FFC', '#B197FC', '#F783AC', '#FFFFFF', '#8FA3BC'];
  var searchTimer = null;

  function roleById(id) {
    for (var i = 0; i < state.roles.length; i++) if (state.roles[i].id === id) return state.roles[i];
    return state.roles[0] || { id: 'player', name: 'Игрок', color: '#8FA3BC' };
  }
  function badge(role) {
    var b = el('span', { class: 'role-badge', text: role.name });
    b.style.setProperty('--c', role.color);
    return b;
  }
  function adminSay(text, kind) { setMsg('adminMsg', text, kind); }

  function setAdminTab(name) {
    var users = name === 'users';
    $('atabUsers').setAttribute('aria-selected', users ? 'true' : 'false');
    $('atabRoles').setAttribute('aria-selected', users ? 'false' : 'true');
    $('panelUsers').hidden = !users;
    $('panelRoles').hidden = users;
    adminSay('');
    if (users) loadUsers(); else renderRoles();
  }

  function loadRoles() {
    return api('GET', '/admin/roles').then(function (d) {
      state.roles = d.roles;
      state.canGrantAdmin = d.canGrantAdmin;
    });
  }

  function loadUsers() {
    var q = $('userSearch').value.trim();
    return api('GET', '/admin/users?q=' + encodeURIComponent(q)).then(function (d) {
      state.canGrantAdmin = d.canGrantAdmin;
      renderUsers(d.users);
    }).catch(function (err) { adminSay(err.message, 'err'); });
  }

  function renderUsers(list) {
    var box = $('userRows');
    box.textContent = '';
    if (!list.length) { box.appendChild(el('div', { class: 'empty', text: 'Игроки не найдены.' })); return; }

    list.forEach(function (u) {
      var role = roleById(u.roleId);
      var nameSpan = el('span', { text: u.nick });
      nameSpan.style.color = role.color;
      var nameBox = el('div', { class: 'row-name' }, [icon('user'), nameSpan]);
      if (u.owner) nameBox.appendChild(el('span', { class: 'owner-tag', text: 'владелец' }));

      var select = el('select', { class: 'select', 'aria-label': 'Привилегия игрока ' + u.nick });
      state.roles.forEach(function (r) {
        var opt = el('option', { value: r.id, text: r.name });
        if (r.id === 'admin' && !state.canGrantAdmin) opt.disabled = true;
        if (r.id === u.roleId) opt.selected = true;
        select.appendChild(opt);
      });
      var locked = u.owner || (u.roleId === 'admin' && !state.canGrantAdmin);
      select.disabled = locked;
      var prev = u.roleId;

      select.addEventListener('change', function () {
        var chosen = select.value;
        select.disabled = true;
        api('POST', '/admin/users/' + encodeURIComponent(u.nick) + '/role', { roleId: chosen })
          .then(function (d) {
            prev = chosen;
            u.roleId = chosen;
            nameSpan.style.color = d.role.color;
            adminSay('Игроку ' + u.nick + ' выдана привилегия «' + d.role.name + '».', 'ok');
            if (state.user && state.user.nick.toLowerCase() === u.nick.toLowerCase()) refreshMe();
          })
          .catch(function (err) { select.value = prev; adminSay(err.message, 'err'); })
          .then(function () { select.disabled = u.owner || (u.roleId === 'admin' && !state.canGrantAdmin); });
      });

      box.appendChild(el('div', { class: 'row' }, [
        nameBox,
        el('div', { class: 'row-mail', text: u.email || '—', title: u.email || '' }),
        select
      ]));
    });
  }

  function renderRoles() {
    var box = $('roleRows');
    box.textContent = '';
    state.roles.forEach(function (r) {
      var picker = el('input', { type: 'color', value: r.color, 'aria-label': 'Цвет привилегии ' + r.name });
      var hex = el('input', { type: 'text', value: r.color, maxlength: '7', spellcheck: 'false', 'aria-label': 'HEX цвета ' + r.name });
      picker.addEventListener('input', function () { hex.value = picker.value.toUpperCase(); });
      hex.addEventListener('input', function () { if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) picker.value = hex.value; });

      var save = el('button', { type: 'button', class: 'btn btn-outline btn-sm btn-icon', 'aria-label': 'Сохранить цвет ' + r.name, title: 'Сохранить цвет' }, [icon('save')]);
      save.addEventListener('click', function () {
        var color = hex.value.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) return adminSay('Цвет должен быть в формате #RRGGBB.', 'err');
        api('PATCH', '/admin/roles/' + r.id, { color: color })
          .then(function () { adminSay('Цвет привилегии «' + r.name + '» сохранён.', 'ok'); return loadRoles(); })
          .then(function () { renderRoles(); return refreshMe(); })
          .catch(function (err) { adminSay(err.message, 'err'); });
      });

      var actions = el('div', { class: 'role-actions' }, [el('div', { class: 'color-pick' }, [picker, hex]), save]);

      if (!r.builtin) {
        var del = el('button', { type: 'button', class: 'btn btn-danger btn-sm btn-icon', 'aria-label': 'Удалить привилегию ' + r.name, title: 'Удалить' }, [icon('trash')]);
        del.addEventListener('click', function () {
          if (del.dataset.sure !== '1') {
            del.dataset.sure = '1';
            adminSay('Нажмите на корзину ещё раз, чтобы удалить «' + r.name + '». Игроки с ней станут «Игрок».', 'err');
            setTimeout(function () { del.dataset.sure = ''; }, 4000);
            return;
          }
          api('DELETE', '/admin/roles/' + r.id)
            .then(function () { adminSay('Привилегия «' + r.name + '» удалена.', 'ok'); return loadRoles(); })
            .then(function () { renderRoles(); return refreshMe(); })
            .catch(function (err) { adminSay(err.message, 'err'); });
        });
        actions.appendChild(del);
      }

      var left = el('div', { class: 'row-name' }, [badge(r)]);
      if (r.builtin) left.appendChild(el('span', { class: 'owner-tag', text: 'встроенная' }));
      box.appendChild(el('div', { class: 'row role-row' }, [left, actions]));
    });
  }

  /* создание привилегии */
  (function initRoleForm() {
    var picker = $('roleColor');
    var hex = $('roleHex');
    picker.addEventListener('input', function () { hex.value = picker.value.toUpperCase(); });
    hex.addEventListener('input', function () { if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) picker.value = hex.value; });

    var sw = $('swatches');
    SWATCHES.forEach(function (c) {
      var b = el('button', { type: 'button', class: 'swatch', 'aria-label': 'Цвет ' + c, title: c });
      b.style.setProperty('--c', c);
      b.addEventListener('click', function () { picker.value = c; hex.value = c; });
      sw.appendChild(b);
    });

    $('roleForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('roleName').value.trim();
      var color = hex.value.trim();
      if (name.length < 2 || name.length > 20) return adminSay('Название: от 2 до 20 символов.', 'err');
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) return adminSay('Цвет должен быть в формате #RRGGBB.', 'err');
      api('POST', '/admin/roles', { name: name, color: color })
        .then(function (d) {
          adminSay('Привилегия «' + d.role.name + '» создана. Теперь её можно выдавать во вкладке «Игроки».', 'ok');
          $('roleName').value = '';
          return loadRoles();
        })
        .then(renderRoles)
        .catch(function (err) { adminSay(err.message, 'err'); });
    });
  })();

  function openAdmin() {
    openDialog(adminDlg);
    adminSay('');
    loadRoles().then(function () { setAdminTab('users'); })
      .catch(function (err) { adminSay(err.message, 'err'); });
  }

  $('userSearch').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadUsers, 250);
  });

  /* ------------------------------------------------------------------
     Общие обработчики
     ------------------------------------------------------------------ */
  document.addEventListener('click', function (e) {
    var open = e.target.closest('[data-open-auth]');
    if (open) { openAuth(open.getAttribute('data-open-auth')); return; }
    var tab = e.target.closest('[data-tab]');
    if (tab) { setTab(tab.getAttribute('data-tab')); return; }
    var atab = e.target.closest('[data-atab]');
    if (atab) { setAdminTab(atab.getAttribute('data-atab')); return; }
    var pw = e.target.closest('[data-toggle-pw]');
    if (pw) {
      var input = document.getElementById(pw.getAttribute('data-toggle-pw'));
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      pw.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
      pw.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    }
  });

  $('authClose').addEventListener('click', function () { closeDialog(dlg); });
  $('adminClose').addEventListener('click', function () { closeDialog(adminDlg); });
  $('adminBtn').addEventListener('click', openAdmin);
  [dlg, adminDlg].forEach(function (d) {
    d.addEventListener('click', function (e) { if (e.target === d) closeDialog(d); });
  });

  refreshMe();
})();
