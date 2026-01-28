// Popup script for Amazon Order Tracker

// Cross-browser compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Cache settings
const CACHE_KEY = 'ordersCache';
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds
const LANG_KEY = 'selectedLanguage';

// Translations
const translations = {
  en: {
    title: 'Amazon Orders',
    subtitle: 'Orders with tracking',
    refreshOrders: 'Refresh orders',
    openAmazonPrompt: 'Open Amazon Orders page to view tracking:',
    openAmazonBtn: 'Open Amazon Orders',
    loading: 'Loading orders...',
    noOrders: 'No orders with tracking numbers found.',
    refreshBtn: 'Refresh Orders',
    processing: 'Processing',
    copyPrice: 'Copy price',
    copyTitle: 'Copy title',
    trackingLabel: 'Track #:',
    copyTracking: 'Copy tracking number',
    trackBtn: 'Track',
    detailsBtn: 'Order Details',
    items: 'items',
    trackingNotAvailable: 'Tracking not yet available',
    // Statuses
    delivered: 'Delivered',
    outForDelivery: 'Out for delivery',
    arrivingToday: 'Arriving today',
    inTransit: 'In transit',
    shipped: 'Shipped',
    justOrdered: 'Just Ordered'
  },
  ru: {
    title: 'Заказы Amazon',
    subtitle: 'Заказы с отслеживанием',
    refreshOrders: 'Обновить заказы',
    openAmazonPrompt: 'Откройте страницу заказов Amazon:',
    openAmazonBtn: 'Открыть заказы Amazon',
    loading: 'Загрузка заказов...',
    noOrders: 'Заказы с трек-номерами не найдены.',
    refreshBtn: 'Обновить заказы',
    processing: 'Обрабатывается',
    copyPrice: 'Копировать цену',
    copyTitle: 'Копировать название',
    trackingLabel: 'Трек #:',
    copyTracking: 'Копировать трек-номер',
    trackBtn: 'Отследить',
    detailsBtn: 'Детали заказа',
    items: 'товаров',
    trackingNotAvailable: 'Отслеживание пока недоступно',
    // Statuses
    delivered: 'Доставлен',
    outForDelivery: 'Доставляется',
    arrivingToday: 'Прибудет сегодня',
    inTransit: 'В пути',
    shipped: 'Отправлен',
    justOrdered: 'Только заказан'
  }
};

let currentLang = 'en';

document.addEventListener('DOMContentLoaded', () => {
  const elements = {
    status: document.getElementById('status'),
    notAmazon: document.getElementById('not-amazon'),
    loading: document.getElementById('loading'),
    ordersContainer: document.getElementById('orders-container'),
    ordersList: document.getElementById('orders-list'),
    noOrders: document.getElementById('no-orders'),
    refreshBtn: document.getElementById('refresh-btn'),
    refreshBtnFallback: document.getElementById('refresh-btn-fallback'),
    langEn: document.getElementById('lang-en'),
    langRu: document.getElementById('lang-ru')
  };

  // Initialize
  init();

  // Event listeners - force refresh when clicking refresh button
  elements.refreshBtn.addEventListener('click', () => fetchOrders(true));
  if (elements.refreshBtnFallback) {
    elements.refreshBtnFallback.addEventListener('click', () => fetchOrders(true));
  }

  // Language switcher listeners
  elements.langEn.addEventListener('click', () => setLanguage('en'));
  elements.langRu.addEventListener('click', () => setLanguage('ru'));

  async function init() {
    // Load saved language
    await loadLanguage();
    applyTranslations();
    await fetchOrders(false);
  }

  // Get translation by key
  function t(key) {
    return translations[currentLang][key] || translations.en[key] || key;
  }

  // Load saved language from storage
  async function loadLanguage() {
    return new Promise((resolve) => {
      browserAPI.storage.local.get([LANG_KEY], (result) => {
        if (browserAPI.runtime.lastError) {
          console.warn('Error loading language:', browserAPI.runtime.lastError);
          resolve();
          return;
        }
        if (result && result[LANG_KEY]) {
          currentLang = result[LANG_KEY];
        }
        updateLangButtons();
        resolve();
      });
    });
  }

  // Set language and save to storage
  function setLanguage(lang) {
    currentLang = lang;
    browserAPI.storage.local.set({ [LANG_KEY]: lang }, () => {
      if (browserAPI.runtime.lastError) {
        console.warn('Error saving language:', browserAPI.runtime.lastError);
      }
    });
    updateLangButtons();
    applyTranslations();
    // Re-render orders if they exist
    const hasOrders = elements.ordersList.children.length > 0;
    if (hasOrders) {
      getCachedOrders().then(orders => {
        if (orders && orders.length > 0) {
          displayOrders(orders);
        }
      });
    }
  }

  // Update language button states
  function updateLangButtons() {
    elements.langEn.classList.toggle('active', currentLang === 'en');
    elements.langRu.classList.toggle('active', currentLang === 'ru');
  }

  // Apply translations to all elements with data-i18n attribute
  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      el.title = t(key);
    });
  }

  // Get cached orders if still valid
  async function getCachedOrders() {
    return new Promise((resolve) => {
      browserAPI.storage.local.get([CACHE_KEY], (result) => {
        if (browserAPI.runtime.lastError) {
          console.warn('Error loading cache:', browserAPI.runtime.lastError);
          resolve(null);
          return;
        }
        const cached = result && result[CACHE_KEY];
        if (cached && cached.orders && cached.timestamp) {
          const age = Date.now() - cached.timestamp;
          if (age < CACHE_TTL) {
            resolve(cached.orders);
            return;
          }
        }
        resolve(null);
      });
    });
  }

  // Save orders to cache
  async function setCachedOrders(orders) {
    return new Promise((resolve) => {
      browserAPI.storage.local.set({
        [CACHE_KEY]: {
          orders: orders,
          timestamp: Date.now()
        }
      }, () => {
        if (browserAPI.runtime.lastError) {
          console.warn('Error saving cache:', browserAPI.runtime.lastError);
        }
        resolve();
      });
    });
  }

  async function fetchOrders(forceRefresh = false) {
    showLoading();

    try {
      // Check cache first (unless force refresh)
      if (!forceRefresh) {
        const cachedOrders = await getCachedOrders();
        if (cachedOrders && cachedOrders.length > 0) {
          displayOrders(cachedOrders);
          return;
        }
      }

      // Get current tab
      const [currentTab] = await browserAPI.tabs.query({ active: true, currentWindow: true });

      let targetTab = null;

      // Check if current tab is Amazon order history
      if (currentTab && isOrderHistoryUrl(currentTab.url)) {
        targetTab = currentTab;
      } else {
        // Search for Amazon order history tab in all tabs
        const allTabs = await browserAPI.tabs.query({});
        targetTab = allTabs.find(tab => isOrderHistoryUrl(tab.url));
      }

      if (!targetTab) {
        showNotAmazon();
        return;
      }

      // Inject content script if needed and get orders
      try {
        await browserAPI.scripting.executeScript({
          target: { tabId: targetTab.id },
          files: ['content.js']
        });
      } catch (e) {
        // Script might already be injected, continue
      }

      // Send message to content script
      const response = await browserAPI.tabs.sendMessage(targetTab.id, { action: 'getOrders' });

      if (response && response.orders && response.orders.length > 0) {
        // Save to cache
        await setCachedOrders(response.orders);
        displayOrders(response.orders);
      } else {
        showNoOrders();
      }

    } catch (error) {
      console.error('Error fetching orders:', error);
      showNotAmazon();
    }
  }

  function isOrderHistoryUrl(url) {
    if (!url) return false;
    // Must be on Amazon AND on order history page (not order-details)
    const isAmazon = url.includes('amazon.com') ||
                     url.includes('amazon.co.uk') ||
                     url.includes('amazon.de') ||
                     url.includes('amazon.fr') ||
                     url.includes('amazon.it') ||
                     url.includes('amazon.es') ||
                     url.includes('amazon.co.jp') ||
                     url.includes('amazon.ca');

    if (!isAmazon) return false;

    // Check it's order history, not order details
    const isOrderHistory = url.includes('order-history') ||
                           url.includes('/your-orders') && !url.includes('order-details');

    return isOrderHistory;
  }

  function showLoading() {
    hideAll();
    elements.loading.classList.remove('hidden');
    elements.refreshBtn.disabled = true;
    elements.refreshBtn.classList.add('is-loading');
  }

  function hideAll() {
    elements.status.classList.add('hidden');
    elements.notAmazon.classList.add('hidden');
    elements.loading.classList.add('hidden');
    elements.noOrders.classList.add('hidden');
    elements.ordersList.innerHTML = '';
  }

  function showNotAmazon() {
    hideAll();
    elements.notAmazon.classList.remove('hidden');
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.classList.remove('is-loading');
  }

  function showNoOrders() {
    hideAll();
    elements.noOrders.classList.remove('hidden');
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.classList.remove('is-loading');
  }

  function showError(message) {
    hideAll();
    elements.status.textContent = message;
    elements.status.classList.remove('hidden', 'success');
    elements.status.classList.add('error');
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.classList.remove('is-loading');
  }

  function showSuccess(message) {
    elements.status.textContent = message;
    elements.status.classList.remove('hidden', 'error');
    elements.status.classList.add('success');
  }

  function displayOrders(orders) {
    hideAll();
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.classList.remove('is-loading');

    if (!orders || orders.length === 0) {
      showNoOrders();
      return;
    }

    orders.forEach(order => {
      const card = createOrderCard(order);
      elements.ordersList.appendChild(card);
    });
  }

  function createOrderCard(order) {
    const card = document.createElement('div');
    card.className = 'order-card';

    const statusClass = getStatusClass(order.status);
    const translatedStatus = translateStatus(order.status);

    // Build images HTML
    let imagesHtml = '';
    if (order.images && order.images.length > 0) {
      if (order.images.length === 1) {
        imagesHtml = `<img src="${escapeHtml(order.images[0])}" alt="Product" class="product-img">`;
      } else {
        // Gallery for multiple items
        imagesHtml = `
          <div class="product-gallery">
            ${order.images.slice(0, 4).map(src =>
              `<img src="${escapeHtml(src)}" alt="Product" class="gallery-img">`
            ).join('')}
            ${order.images.length > 4 ? `<div class="gallery-more">+${order.images.length - 4}</div>` : ''}
          </div>
        `;
      }
    }

    // Item count badge
    const itemCountHtml = order.itemCount > 1
      ? `<span class="item-count">${order.itemCount} ${t('items')}</span>`
      : '';

    const template = document.createElement('template');
    template.innerHTML = `
      <div class="order-content">
        <div class="order-image">
          ${imagesHtml}
          ${itemCountHtml}
        </div>
        <div class="order-info">
          <div class="order-header">
            <span class="order-status ${statusClass}">${translatedStatus || t('processing')}</span>
            ${order.price ? `
            <span class="order-price">
              ${order.price}
              <button class="copy-btn" data-copy="${escapeHtml(order.price.replace(/[^0-9.]/g, ''))}" title="${t('copyPrice')}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </button>
            </span>
            ` : ''}
          </div>
          <div class="order-title-row">
            <div class="order-title">${escapeHtml(order.title) || 'Amazon Order'}</div>
            <button class="copy-btn" data-copy="${escapeHtml(order.title)}" title="${t('copyTitle')}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </div>
          <div class="order-delivery">${order.deliveryDate || ''}</div>
          ${order.trackingNumber ? `
          <div class="order-tracking">
            <span class="tracking-label">${t('trackingLabel')}</span>
            <span class="tracking-number">${escapeHtml(order.trackingNumber)}</span>
            <button class="copy-btn" data-copy="${escapeHtml(order.trackingNumber)}" title="${t('copyTracking')}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </div>
          ` : ''}
        </div>
      </div>
      <div class="order-buttons">
        ${order.trackingUrl ? `
        <a href="${order.hasRealTracking !== false ? escapeHtml(order.trackingUrl) : '#'}"
           target="${order.hasRealTracking !== false ? '_blank' : ''}"
           class="btn-track ${order.hasRealTracking === false ? 'disabled' : ''}"
           ${order.hasRealTracking === false ? `title="${t('trackingNotAvailable')}"` : ''}>${t('trackBtn')}</a>
        ` : ''}
        <a href="https://www.amazon.com/gp/your-account/order-details?orderID=${escapeHtml(order.orderId)}" target="_blank" class="btn-details">${t('detailsBtn')}</a>
      </div>
    `;
    card.replaceChildren(template.content);

    // Add copy button handlers
    card.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = btn.getAttribute('data-copy');
        navigator.clipboard.writeText(text).then(() => {
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1000);
        });
      });
    });

    return card;
  }

  // Translate status to current language
  function translateStatus(status) {
    if (!status) return t('processing');
    const s = status.toLowerCase();
    if (s.includes('delivered')) return t('delivered');
    if (s.includes('out for delivery')) return t('outForDelivery');
    if (s.includes('arriving today')) return t('arrivingToday');
    if (s.includes('transit') || s.includes('arriving') || s.includes('on the way')) return t('inTransit');
    if (s.includes('shipped')) return t('shipped');
    if (s.includes('just ordered')) return t('justOrdered');
    return t('processing');
  }

  function getStatusClass(status) {
    if (!status) return 'processing';
    const s = status.toLowerCase();
    if (s.includes('delivered')) return 'delivered';
    if (s.includes('out for delivery') || s.includes('arriving today')) return 'arriving-today';
    if (s.includes('transit') || s.includes('arriving') || s.includes('on the way')) return 'in-transit';
    if (s.includes('shipped')) return 'shipped';
    if (s.includes('just ordered')) return 'just-ordered';
    return 'processing';
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
});
