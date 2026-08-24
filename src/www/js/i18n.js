'use strict';

window.awgI18n = (() => {
  const messages = {
    en: {
      tagline: 'Simple panel for AmneziaWG 3.x', logout: 'Sign out', loginTitle: 'Panel sign in',
      loginHint: 'The panel is available only to Home VPN clients.', password: 'Password', login: 'Sign in',
      clients: 'Clients', clientsHint: 'Home — home network, Guest — internet only.', addClient: 'Add client',
      panelPassword: 'Panel password', currentPassword: 'Current password', newPassword: 'New password',
      changePassword: 'Change password', newClient: 'New client', close: 'Close', name: 'Name',
        namePlaceholder: "For example, Alex's phone", access: 'Network access', guestOption: 'Guest — internet only',
      homeOption: 'Home — home network and panel', create: 'Create', profileTitle: 'Client profile',
      qrAlt: 'AmneziaVPN profile QR code', profileNote: 'Open the profile in AmneziaVPN on this device, copy its link, or download the configuration.',
      openProfile: 'Open in AmneziaVPN', copyProfile: 'Copy link', downloadConfig: 'Download .conf',
      homeNetwork: 'Home network', homeDesc: 'Home can access the panel and other Home clients',
      clientEnabled: 'Client enabled', enabledDesc: 'Disabling immediately removes the peer from AWG',
      showProfile: 'Profile', delete: 'Delete', disabled: 'Disabled', deleted: 'Client deleted',
      copied: 'Link copied', deleteConfirm: 'Delete client “{name}”? Its profile will stop connecting.',
      deleteTitle: 'Delete client?', cancel: 'Cancel', deleteDisconnectHint: 'If this device uses that profile now, the panel will disconnect as soon as deletion succeeds.',
      deletingClient: 'Deleting client…', deletedConnectionLost: 'The request was sent. The panel disconnected because this device was using the deleted profile.', duplicateName: 'A client with this name already exists.',
      passwordChanged: 'Password changed. All previous sessions ended — sign in again.', httpError: 'HTTP error {status}',
    },
    ru: {
      tagline: 'Простая панель для AmneziaWG 3.x', logout: 'Выйти', loginTitle: 'Вход в панель',
      loginHint: 'Панель доступна только домашним клиентам VPN.', password: 'Пароль', login: 'Войти',
      clients: 'Клиенты', clientsHint: 'Home — домашняя сеть, Guest — только интернет.', addClient: 'Добавить клиента',
      panelPassword: 'Пароль панели', currentPassword: 'Текущий пароль', newPassword: 'Новый пароль',
      changePassword: 'Сменить пароль', newClient: 'Новый клиент', close: 'Закрыть', name: 'Название',
        namePlaceholder: 'Например, телефон Алексея', access: 'Доступ к сети', guestOption: 'Guest — только интернет',
      homeOption: 'Home — домашняя сеть и панель', create: 'Создать', profileTitle: 'Профиль клиента',
      qrAlt: 'QR-код профиля AmneziaVPN', profileNote: 'Откройте профиль в AmneziaVPN на этом устройстве, скопируйте ссылку или скачайте конфигурацию.',
      openProfile: 'Открыть в AmneziaVPN', copyProfile: 'Копировать ссылку', downloadConfig: 'Скачать .conf',
      homeNetwork: 'Домашняя сеть', homeDesc: 'Home видит панель и других Home-клиентов',
      clientEnabled: 'Клиент включён', enabledDesc: 'Отключение немедленно удаляет peer из AWG',
      showProfile: 'Профиль', delete: 'Удалить', disabled: 'Отключён', deleted: 'Клиент удалён',
      copied: 'Ссылка скопирована', deleteConfirm: 'Удалить клиент «{name}»? Его профиль перестанет подключаться.',
      deleteTitle: 'Удалить клиента?', cancel: 'Отмена', deleteDisconnectHint: 'Если это устройство сейчас подключено через удаляемый профиль, панель отключится сразу после успешного удаления.',
      deletingClient: 'Удаление клиента…', deletedConnectionLost: 'Запрос отправлен. Панель отключилась, потому что это устройство использовало удалённый профиль.', duplicateName: 'Клиент с таким названием уже существует.',
      passwordChanged: 'Пароль изменён. Все старые сессии завершены — войдите снова.', httpError: 'Ошибка HTTP {status}',
    },
    es: {
      tagline: 'Panel sencillo para AmneziaWG 3.x', logout: 'Cerrar sesión', loginTitle: 'Acceso al panel',
      loginHint: 'El panel solo está disponible para clientes Home de la VPN.', password: 'Contraseña', login: 'Entrar',
      clients: 'Clientes', clientsHint: 'Home — red doméstica, Guest — solo internet.', addClient: 'Añadir cliente',
      panelPassword: 'Contraseña del panel', currentPassword: 'Contraseña actual', newPassword: 'Nueva contraseña',
      changePassword: 'Cambiar contraseña', newClient: 'Nuevo cliente', close: 'Cerrar', name: 'Nombre',
        namePlaceholder: 'Por ejemplo, teléfono de Alex', access: 'Acceso a la red', guestOption: 'Guest — solo internet',
      homeOption: 'Home — red doméstica y panel', create: 'Crear', profileTitle: 'Perfil del cliente',
      qrAlt: 'Código QR del perfil de AmneziaVPN', profileNote: 'Abre el perfil en AmneziaVPN, copia el enlace o descarga la configuración.',
      openProfile: 'Abrir en AmneziaVPN', copyProfile: 'Copiar enlace', downloadConfig: 'Descargar .conf',
      homeNetwork: 'Red doméstica', homeDesc: 'Home puede acceder al panel y a otros clientes Home',
      clientEnabled: 'Cliente activado', enabledDesc: 'Al desactivarlo, el peer se elimina inmediatamente de AWG',
      showProfile: 'Perfil', delete: 'Eliminar', disabled: 'Desactivado', deleted: 'Cliente eliminado',
      copied: 'Enlace copiado', deleteConfirm: '¿Eliminar el cliente «{name}»? Su perfil dejará de conectarse.',
      deleteTitle: '¿Eliminar cliente?', cancel: 'Cancelar', deleteDisconnectHint: 'Si este dispositivo usa ahora ese perfil, el panel se desconectará al eliminarlo.', deletingClient: 'Eliminando cliente…', deletedConnectionLost: 'La solicitud fue enviada. El panel se desconectó porque este dispositivo usaba el perfil eliminado.', duplicateName: 'Ya existe un cliente con este nombre.',
      passwordChanged: 'Contraseña cambiada. Todas las sesiones anteriores finalizaron; vuelve a entrar.', httpError: 'Error HTTP {status}',
    },
    'zh-cn': {
      tagline: '简洁的 AmneziaWG 3.x 管理面板', logout: '退出登录', loginTitle: '登录面板',
      loginHint: '只有 VPN 的 Home 客户端可以访问此面板。', password: '密码', login: '登录',
      clients: '客户端', clientsHint: 'Home — 家庭网络，Guest — 仅访问互联网。', addClient: '添加客户端',
      panelPassword: '面板密码', currentPassword: '当前密码', newPassword: '新密码',
      changePassword: '更改密码', newClient: '新客户端', close: '关闭', name: '名称',
        namePlaceholder: '例如：小明的手机', access: '网络访问权限', guestOption: 'Guest — 仅访问互联网',
      homeOption: 'Home — 家庭网络和面板', create: '创建', profileTitle: '客户端配置',
      qrAlt: 'AmneziaVPN 配置二维码', profileNote: '在此设备的 AmneziaVPN 中打开配置、复制链接或下载配置文件。',
      openProfile: '在 AmneziaVPN 中打开', copyProfile: '复制链接', downloadConfig: '下载 .conf',
      homeNetwork: '家庭网络', homeDesc: 'Home 可以访问面板和其他 Home 客户端',
      clientEnabled: '启用客户端', enabledDesc: '停用后会立即从 AWG 中移除此 peer',
      showProfile: '配置', delete: '删除', disabled: '已停用', deleted: '客户端已删除',
      copied: '链接已复制', deleteConfirm: '要删除客户端“{name}”吗？其配置将无法再连接。',
      deleteTitle: '删除客户端？', cancel: '取消', deleteDisconnectHint: '如果此设备正在使用该配置，删除成功后面板会立即断开。', deletingClient: '正在删除客户端…', deletedConnectionLost: '请求已发送。由于此设备使用了被删除的配置，面板已断开。', duplicateName: '已存在同名客户端。',
      passwordChanged: '密码已更改。所有旧会话均已结束，请重新登录。', httpError: 'HTTP 错误 {status}',
    },
    fa: {
      tagline: 'پنل ساده برای AmneziaWG 3.x', logout: 'خروج', loginTitle: 'ورود به پنل',
      loginHint: 'پنل فقط برای کاربران Home شبکهٔ VPN در دسترس است.', password: 'رمز عبور', login: 'ورود',
      clients: 'کاربران', clientsHint: 'Home — شبکهٔ خانگی، Guest — فقط اینترنت.', addClient: 'افزودن کاربر',
      panelPassword: 'رمز عبور پنل', currentPassword: 'رمز عبور فعلی', newPassword: 'رمز عبور جدید',
      changePassword: 'تغییر رمز عبور', newClient: 'کاربر جدید', close: 'بستن', name: 'نام',
        namePlaceholder: 'مثلاً تلفن الکس', access: 'دسترسی شبکه', guestOption: 'Guest — فقط اینترنت',
      homeOption: 'Home — شبکهٔ خانگی و پنل', create: 'ایجاد', profileTitle: 'پروفایل کاربر',
      qrAlt: 'کد QR پروفایل AmneziaVPN', profileNote: 'پروفایل را در AmneziaVPN باز کنید، پیوند را کپی کنید یا فایل تنظیمات را بگیرید.',
      openProfile: 'باز کردن در AmneziaVPN', copyProfile: 'کپی پیوند', downloadConfig: 'دریافت .conf',
      homeNetwork: 'شبکهٔ خانگی', homeDesc: 'کاربران Home به پنل و دیگر کاربران Home دسترسی دارند',
      clientEnabled: 'کاربر فعال است', enabledDesc: 'غیرفعال‌سازی فوراً peer را از AWG حذف می‌کند',
      showProfile: 'پروفایل', delete: 'حذف', disabled: 'غیرفعال', deleted: 'کاربر حذف شد',
      copied: 'پیوند کپی شد', deleteConfirm: 'کاربر «{name}» حذف شود؟ پروفایل او دیگر متصل نخواهد شد.',
      deleteTitle: 'کاربر حذف شود؟', cancel: 'لغو', deleteDisconnectHint: 'اگر این دستگاه اکنون از همان پروفایل استفاده کند، پس از حذف پنل قطع می‌شود.', deletingClient: 'در حال حذف کاربر…', deletedConnectionLost: 'درخواست ارسال شد. پنل به‌دلیل استفادهٔ این دستگاه از پروفایل حذف‌شده قطع شد.', duplicateName: 'کاربری با این نام وجود دارد.',
      passwordChanged: 'رمز عبور تغییر کرد. همهٔ نشست‌های قبلی پایان یافتند؛ دوباره وارد شوید.', httpError: 'خطای HTTP {status}',
    },
  };
  let language = 'en';
  const t = (key, values = {}) => (messages[language][key] ?? messages.en[key] ?? key)
    .replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
  const translate = (root = document) => {
    root.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
    root.querySelectorAll('[data-i18n-label]').forEach((node) => { node.setAttribute('aria-label', t(node.dataset.i18nLabel)); });
    root.querySelectorAll('[data-i18n-alt]').forEach((node) => { node.alt = t(node.dataset.i18nAlt); });
  };
  const setLanguage = (value) => {
    language = Object.hasOwn(messages, value) ? value : 'en';
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'fa' ? 'rtl' : 'ltr';
    translate();
  };
  return Object.freeze({ setLanguage, t, translate });
})();
