// Background script for Amazon Order Tracker

// Cross-browser compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Handle extension installation
browserAPI.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Amazon Order Tracker installed');
  }
});

// Cache for order details to avoid repeated fetches
const orderDetailsCache = new Map();
const trackingCache = new Map();
const ordersCache = { orders: null, timestamp: 0 };
const CACHE_TTL = 60000; // 1 minute cache

// Handle messages from content scripts or popup
browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // Fetch orders directly from Amazon order history page
  if (request.action === 'fetchOrders') {
    const baseUrl = request.baseUrl || 'https://www.amazon.com';

    // Check cache
    if (ordersCache.orders && (Date.now() - ordersCache.timestamp) < CACHE_TTL) {
      fetchOrderPrices(ordersCache.orders, baseUrl).then(ordersWithPrices => {
        sendResponse({ success: true, orders: ordersWithPrices });
      });
      return true;
    }

    const historyUrl = `${baseUrl}/gp/your-account/order-history?orderFilter=months-6`;

    fetch(historyUrl, { credentials: 'include' })
      .then(response => response.text())
      .then(html => {
        const orders = parseOrderHistoryHtml(html, baseUrl);

        ordersCache.orders = orders;
        ordersCache.timestamp = Date.now();

        // Fetch prices for all orders
        return fetchOrderPrices(orders, baseUrl);
      })
      .then(ordersWithPrices => {
        sendResponse({ success: true, orders: ordersWithPrices });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });

    return true;
  }

  if (request.action === 'openOrderHistory') {
    browserAPI.tabs.create({
      url: 'https://www.amazon.com/gp/your-account/order-history'
    });
    sendResponse({ success: true });
  }

  if (request.action === 'openTracking') {
    const { trackingNumber, carrier } = request;
    let url = '';

    switch (carrier?.toLowerCase()) {
      case 'ups':
        url = `https://www.ups.com/track?tracknum=${trackingNumber}`;
        break;
      case 'fedex':
        url = `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
        break;
      case 'usps':
        url = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
        break;
      case 'amazon':
        url = `https://www.amazon.com/progress-tracker/package/${trackingNumber}`;
        break;
      case 'dhl':
        url = `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`;
        break;
      default:
        // Generic tracking - try 17track
        url = `https://t.17track.net/en#nums=${trackingNumber}`;
    }

    if (url) {
      browserAPI.tabs.create({ url });
    }

    sendResponse({ success: true });
  }

  // Generic fetch HTML - returns raw HTML for parsing in content script
  if (request.action === 'fetchHtml') {
    const { url } = request;

    fetch(url, { credentials: 'include' })
      .then(response => response.text())
      .then(html => {
        sendResponse({ success: true, html: html });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });

    return true;
  }

  // Fetch tracking number from tracking page
  if (request.action === 'getTrackingNumber') {
    const { trackingUrl } = request;

    // Check cache
    if (trackingCache.has(trackingUrl)) {
      sendResponse({ success: true, trackingNumber: trackingCache.get(trackingUrl) });
      return true;
    }

    fetch(trackingUrl, { credentials: 'include' })
      .then(response => response.text())
      .then(html => {
        const trackingNumber = parseTrackingPageHtml(html);
        if (trackingNumber) {
          trackingCache.set(trackingUrl, trackingNumber);
        }
        sendResponse({ success: true, trackingNumber: trackingNumber });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });

    return true;
  }

  // Fetch order details and parse item prices
  if (request.action === 'getOrderPrices') {
    const { orderId, baseUrl } = request;

    // Check cache first
    if (orderDetailsCache.has(orderId)) {
      sendResponse({ success: true, items: orderDetailsCache.get(orderId) });
      return true;
    }

    // Fetch order details page
    const detailsUrl = `${baseUrl}/gp/your-account/order-details?ie=UTF8&orderID=${orderId}`;

    fetch(detailsUrl, { credentials: 'include' })
      .then(response => response.text())
      .then(html => {
        const items = parseOrderDetailsHtml(html);
        orderDetailsCache.set(orderId, items);
        sendResponse({ success: true, items: items });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });

    return true; // Keep message channel open for async response
  }

  return true;
});

// Parse order details HTML to extract item prices (regex-based for service worker)
function parseOrderDetailsHtml(html) {
  const items = [];
  const seenAsins = new Set();

  // Method 1: Look for shipment-item blocks which contain both ASIN and price together
  // Amazon typically groups item info in specific containers
  const itemBlockRegex = /\/dp\/([A-Z0-9]{10})[^"]*"[^>]*>([^<]{3,100})<[\s\S]{0,2000}?(?:a-price[^>]*>[^<]*<[^>]*>|a-color-price[^>]*>)\s*\$(\d+\.?\d*)/g;

  let blockMatch;
  while ((blockMatch = itemBlockRegex.exec(html)) !== null) {
    const asin = blockMatch[1];
    const title = blockMatch[2].trim();
    const price = parseFloat(blockMatch[3]);

    if (!seenAsins.has(asin) && title.length > 3 && price > 0) {
      seenAsins.add(asin);
      items.push({ title, price, asin });
    }
  }

  // Method 2: If method 1 didn't find items, try alternative pattern
  if (items.length === 0) {
    // Look for yohtmlc-item or od-shipment-item blocks
    const altRegex = /\/dp\/([A-Z0-9]{10})[^"]*"[\s\S]{0,500}?>([^<]{3,100})<[\s\S]{0,1500}?\$(\d+\.?\d*)/g;

    while ((blockMatch = altRegex.exec(html)) !== null) {
      const asin = blockMatch[1];
      const title = blockMatch[2].trim();
      const price = parseFloat(blockMatch[3]);

      if (!seenAsins.has(asin) && title.length > 3 && price > 0) {
        seenAsins.add(asin);
        items.push({ title, price, asin });
      }
    }
  }

  return items;
}

// Parse order history HTML to extract orders (regex-based for service worker)
function parseOrderHistoryHtml(html, baseUrl) {
  const orders = [];
  const seenShipments = new Set();
  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  // Find all ship-track links with regex
  const trackLinkRegex = /<a[^>]*href="([^"]*ship-track[^"]*)"/g;
  let linkMatch;

  while ((linkMatch = trackLinkRegex.exec(html)) !== null) {
    const href = linkMatch[1];

    // Extract orderId and shipmentId
    const orderIdMatch = href.match(/orderId=(\d{3}-\d{7}-\d{7})/);
    const shipmentIdMatch = href.match(/shipmentId=([A-Za-z0-9]+)/);
    if (!orderIdMatch) continue;

    const orderId = orderIdMatch[1];
    const shipmentId = shipmentIdMatch ? shipmentIdMatch[1] : '';
    const uniqueKey = shipmentId || orderId;

    if (seenShipments.has(uniqueKey)) continue;
    seenShipments.add(uniqueKey);

    const order = {
      orderId,
      title: '',
      titles: [],
      asins: [],
      trackingNumber: '',
      deliveryDate: '',
      deliveryDateRaw: null,
      status: '',
      statusRaw: '',
      carrier: 'Amazon',
      trackingUrl: baseUrl + href,
      images: [],
      itemCount: 0,
      price: '',
      totalPrice: 0
    };

    // Find context around this link (5000 chars before)
    const linkIndex = linkMatch.index;
    const contextStart = Math.max(0, linkIndex - 5000);
    const context = html.substring(contextStart, linkIndex + 1000);

    // Extract status from context
    const statusMatch = context.match(/delivery-box__primary-text[^>]*>([^<]+)</i) ||
                        context.match(/shipment-status-primaryText[^>]*>([^<]+)</i);
    if (statusMatch) {
      order.statusRaw = statusMatch[1].trim();
      order.status = parseStatus(order.statusRaw);
      order.deliveryDate = order.statusRaw;
      order.deliveryDateRaw = parseDeliveryDate(order.statusRaw);
    }

    // Extract images from context
    const imgRegex = /product-image[^>]*>.*?<img[^>]*src="([^"]+)"/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(context)) !== null) {
      if (!order.images.includes(imgMatch[1])) {
        order.images.push(imgMatch[1]);
      }
    }
    order.itemCount = order.images.length || 1;

    // Extract titles and ASINs from context
    const titleRegex = /<a[^>]*href="[^"]*\/dp\/([A-Z0-9]{10})[^"]*"[^>]*>([^<]+)</g;
    let titleMatch;
    const seenAsins = new Set();

    while ((titleMatch = titleRegex.exec(context)) !== null) {
      const asin = titleMatch[1];
      const title = titleMatch[2].trim();

      if (title.length > 3 && !order.titles.includes(title)) {
        order.titles.push(title);
      }
      if (!seenAsins.has(asin)) {
        seenAsins.add(asin);
        order.asins.push(asin);
      }
    }

    if (order.titles.length > 0) {
      order.title = order.titles.join(' AND ');
    }

    // Filter out old delivered orders
    if (order.status === 'Delivered' && order.deliveryDateRaw) {
      if (order.deliveryDateRaw < fourteenDaysAgo) {
        continue;
      }
    }

    orders.push(order);
  }

  return orders;
}

// Fetch prices for all orders
async function fetchOrderPrices(orders, baseUrl) {
  const orderIds = [...new Set(orders.map(o => o.orderId))];
  const priceMap = new Map();

  // Fetch prices for each unique order
  await Promise.all(orderIds.map(async orderId => {
    try {
      // Check cache
      if (orderDetailsCache.has(orderId)) {
        priceMap.set(orderId, orderDetailsCache.get(orderId));
        return;
      }

      const detailsUrl = `${baseUrl}/gp/your-account/order-details?ie=UTF8&orderID=${orderId}`;
      const response = await fetch(detailsUrl, { credentials: 'include' });
      const html = await response.text();
      const items = parseOrderDetailsHtml(html);

      orderDetailsCache.set(orderId, items);
      priceMap.set(orderId, items);
    } catch (e) {
      priceMap.set(orderId, []);
    }
  }));

  // Update orders with prices
  orders.forEach(order => {
    const itemsWithPrices = priceMap.get(order.orderId) || [];

    if (itemsWithPrices.length > 0 && order.asins && order.asins.length > 0) {
      let totalPrice = 0;
      order.asins.forEach(asin => {
        const item = itemsWithPrices.find(i => i.asin === asin);
        if (item) {
          totalPrice += item.price;
        }
      });

      if (totalPrice > 0) {
        order.totalPrice = totalPrice;
        order.price = '$' + totalPrice.toFixed(2);
      }
    }
  });

  // Now fetch tracking numbers
  await fetchTrackingNumbers(orders);

  return orders;
}

// Fetch tracking numbers from tracking pages
async function fetchTrackingNumbers(orders) {
  await Promise.all(orders.map(async order => {
    if (!order.trackingUrl || order.trackingNumber) return;

    // Check cache
    const cacheKey = order.trackingUrl;
    if (trackingCache.has(cacheKey)) {
      order.trackingNumber = trackingCache.get(cacheKey);
      return;
    }

    try {
      const response = await fetch(order.trackingUrl, { credentials: 'include' });
      const html = await response.text();
      const trackingNumber = parseTrackingPageHtml(html);

      if (trackingNumber) {
        order.trackingNumber = trackingNumber;
        trackingCache.set(cacheKey, trackingNumber);
      }
    } catch (e) {
      // Silently fail
    }
  }));
}

// Parse tracking page HTML to extract tracking number (regex-based for service worker)
function parseTrackingPageHtml(html) {
  // Common patterns for tracking numbers
  const patterns = [
    /\bTBA\d{12,}\b/,                    // Amazon Logistics
    /\b1Z[A-Z0-9]{16}\b/,                // UPS
    /\b9[2-5]\d{20,22}\b/,               // USPS
    /\b[A-Z]{2}\d{9}[A-Z]{2}\b/,         // International
  ];

  // Try to find tracking number near tracking-related class names
  const trackingAreaRegex = /(?:tracking|carrierRelatedInfo|trackingId)[^>]*>([^<]{10,40})</gi;
  let areaMatch;
  while ((areaMatch = trackingAreaRegex.exec(html)) !== null) {
    const text = areaMatch[1].trim();
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[0];
    }
  }

  // Search in full HTML for tracking patterns
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[0];
  }

  return '';
}

// Parse status text to standard status
function parseStatus(statusText) {
  const text = statusText.toLowerCase();

  if (text.includes('delivered')) return 'Delivered';
  if (text.includes('out for delivery')) return 'Out for delivery';
  if (text.includes('arriving today')) return 'Arriving today';
  if (text.includes('arriving')) return 'In transit';
  if (text.includes('shipped')) return 'Shipped';
  if (text.includes('on the way')) return 'In transit';
  if (text.includes('expected')) return 'In transit';

  return statusText;
}

// Parse delivery date from status text
function parseDeliveryDate(statusText) {
  const months = {
    'january': 0, 'february': 1, 'march': 2, 'april': 3,
    'may': 4, 'june': 5, 'july': 6, 'august': 7,
    'september': 8, 'october': 9, 'november': 10, 'december': 11
  };

  const dateMatch = statusText.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);

  if (dateMatch) {
    const monthStr = dateMatch[1].toLowerCase();
    const day = parseInt(dateMatch[2], 10);
    let year = dateMatch[3] ? parseInt(dateMatch[3], 10) : new Date().getFullYear();

    const month = months[monthStr];
    const date = new Date(year, month, day);

    if (date > new Date() && statusText.toLowerCase().includes('delivered')) {
      date.setFullYear(date.getFullYear() - 1);
    }

    return date;
  }

  return null;
}
