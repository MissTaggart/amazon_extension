// Content script for parsing Amazon order pages

(function() {
  'use strict';

  // Cross-browser compatibility
  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  // Listen for messages from popup
  browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getOrders') {
      (async () => {
        try {
          const orders = await parseOrdersWithPrices();
          sendResponse({ orders: orders });
        } catch (err) {
          sendResponse({ orders: parseOrders() });
        }
      })();
      return true;
    }
    return true;
  });

  // Parse orders and fetch prices from order details pages
  async function parseOrdersWithPrices() {
    const orders = parseOrders();

    // Get unique orderIds that need price fetching
    const orderIds = [...new Set(orders.map(o => o.orderId))];

    // Get base URL (amazon.com, amazon.co.uk, etc.)
    const baseUrl = window.location.origin;

    // Fetch prices via background script, parse in content script
    const priceMap = new Map();

    await Promise.all(orderIds.map(async orderId => {
      try {
        const detailsUrl = `${baseUrl}/gp/your-account/order-details?ie=UTF8&orderID=${orderId}`;
        const html = await new Promise((resolve, reject) => {
          browserAPI.runtime.sendMessage(
            { action: 'fetchHtml', url: detailsUrl },
            response => {
              if (response && response.success) {
                resolve(response.html);
              } else {
                reject(new Error(response?.error || 'Failed to fetch'));
              }
            }
          );
        });
        const items = parseOrderDetailsHtml(html);
        priceMap.set(orderId, items);
      } catch (e) {
        priceMap.set(orderId, []);
      }
    }));

    // Update orders with correct prices
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

    // Fetch tracking numbers via background script
    await Promise.all(orders
      .filter(o => o.trackingUrl && o.hasRealTracking !== false)
      .map(async order => {
        try {
          const html = await new Promise((resolve, reject) => {
            browserAPI.runtime.sendMessage(
              { action: 'fetchHtml', url: order.trackingUrl },
              response => {
                if (response && response.success) {
                  resolve(response.html);
                } else {
                  reject(new Error(response?.error || 'Failed to fetch'));
                }
              }
            );
          });
          order.trackingNumber = parseTrackingPageHtml(html);
        } catch (e) {
          // Silently fail for tracking
        }
      })
    );

    return orders;
  }

  // Parse order details HTML to extract item prices (DOM-based, runs in content script)
  function parseOrderDetailsHtml(html) {
    const items = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Method 1: Find shipment items with their prices
    doc.querySelectorAll('.yohtmlc-item, .a-box.shipment, [class*="od-shipment"]').forEach(itemBox => {
      const linkEl = itemBox.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
      const priceEl = itemBox.querySelector('.a-price .a-offscreen, .a-color-price, [class*="price"]');

      if (linkEl) {
        const href = linkEl.getAttribute('href') || '';
        const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})|\/gp\/product\/([A-Z0-9]{10})/);
        const asin = asinMatch ? (asinMatch[1] || asinMatch[2]) : '';
        const title = linkEl.textContent.trim();

        let price = 0;
        if (priceEl) {
          const priceMatch = priceEl.textContent.match(/\$?([\d,.]+)/);
          if (priceMatch) {
            price = parseFloat(priceMatch[1].replace(',', ''));
          }
        }

        if (asin && !items.find(item => item.asin === asin)) {
          items.push({ title, price, asin });
        }
      }
    });

    // Method 2: If method 1 didn't find items, try alternative approach
    if (items.length === 0) {
      doc.querySelectorAll('a[href*="/dp/"]').forEach(linkEl => {
        const href = linkEl.getAttribute('href') || '';
        const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/);
        if (!asinMatch) return;

        const asin = asinMatch[1];
        const title = linkEl.textContent.trim();
        if (title.length < 5 || items.find(item => item.asin === asin)) return;

        let parent = linkEl.parentElement;
        let price = 0;

        for (let i = 0; i < 10 && parent; i++) {
          const priceEl = parent.querySelector('.a-price .a-offscreen, .a-color-price');
          if (priceEl) {
            const priceMatch = priceEl.textContent.match(/\$?([\d,.]+)/);
            if (priceMatch) {
              price = parseFloat(priceMatch[1].replace(',', ''));
              break;
            }
          }
          parent = parent.parentElement;
        }

        if (price > 0) {
          items.push({ title, price, asin });
        }
      });
    }

    return items;
  }

  // Parse tracking page HTML to extract tracking number
  function parseTrackingPageHtml(html) {
    const patterns = [
      /\bTBA\d{12,}\b/,
      /\b1Z[A-Z0-9]{16}\b/,
      /\b9[2-5]\d{20,22}\b/,
      /\b[A-Z]{2}\d{9}[A-Z]{2}\b/,
    ];

    // Try DOM parsing first
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const selectors = [
        '.carrierRelatedInfo-trackingId-text',
        '[data-test-id="tracking-number"]',
        '.tracking-number',
        '.pt-delivery-card-trackingId'
      ];

      for (const selector of selectors) {
        const el = doc.querySelector(selector);
        if (el) {
          const text = el.textContent.trim();
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) return match[0];
          }
        }
      }
    } catch (e) {}

    // Fallback to regex on full HTML
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) return match[0];
    }

    return '';
  }

  function parseOrders() {
    const orders = [];
    const seenShipments = new Set();
    const now = new Date();
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    // Primary method: Find all "Track package" links and work backwards to find order info
    const trackLinks = document.querySelectorAll('a[href*="ship-track"]');

    trackLinks.forEach(link => {
      const href = link.href || '';

      // Extract orderId and shipmentId from URL
      const orderIdMatch = href.match(/orderId=(\d{3}-\d{7}-\d{7})/);
      const shipmentIdMatch = href.match(/shipmentId=([A-Za-z0-9]+)/);
      if (!orderIdMatch) return;

      const orderId = orderIdMatch[1];
      const shipmentId = shipmentIdMatch ? shipmentIdMatch[1] : '';

      // Use shipmentId to track unique shipments (different packages in same order)
      const uniqueKey = shipmentId || orderId;
      if (seenShipments.has(uniqueKey)) return;
      seenShipments.add(uniqueKey);

      // Find the order container by walking up the DOM
      let orderContainer = findOrderContainer(link);

      const order = {
        orderId: orderId,
        title: '',
        titles: [],
        asins: [],
        trackingNumber: '',
        deliveryDate: '',
        deliveryDateRaw: null,
        status: '',
        statusRaw: '',
        carrier: 'Amazon',
        trackingUrl: href,
        images: [],
        itemCount: 0,
        price: '',
        totalPrice: 0,
        hasRealTracking: true // Will be set to false if "View or edit order" button exists
      };

      if (orderContainer) {
        // Extract status from delivery box
        const statusEl = orderContainer.querySelector('.delivery-box__primary-text, .yohtmlc-shipment-status-primaryText');
        if (statusEl) {
          order.statusRaw = statusEl.textContent.trim();
          order.status = parseStatus(order.statusRaw);
          order.deliveryDate = order.statusRaw;

          // Try to parse delivery date for filtering
          order.deliveryDateRaw = parseDeliveryDate(order.statusRaw);
        }

        // Extract all product images
        const imageEls = orderContainer.querySelectorAll('.product-image img');
        imageEls.forEach(img => {
          const src = img.src || img.getAttribute('data-a-hires');
          if (src && !order.images.includes(src)) {
            order.images.push(src);
          }
        });
        order.itemCount = order.images.length || 1;

        // Extract all product titles and ASINs
        const seenAsins = new Set();
        const seenTitles = new Set();

        // First pass: get titles from .yohtmlc-product-title (reliable source)
        orderContainer.querySelectorAll('.yohtmlc-product-title a').forEach(titleEl => {
          const title = titleEl.textContent.trim();
          const href = titleEl.getAttribute('href') || '';
          const asinMatch = href.match(/\/dp\/([A-Z0-9]+)/);
          const asin = asinMatch ? asinMatch[1] : '';

          if (title.length > 3 && !seenTitles.has(title)) {
            seenTitles.add(title);
            order.titles.push(title);
          }

          if (asin && !seenAsins.has(asin)) {
            seenAsins.add(asin);
            order.asins.push(asin);
          }
        });

        // Second pass: get any additional ASINs from product links
        orderContainer.querySelectorAll('a[href*="/dp/"]').forEach(linkEl => {
          const href = linkEl.getAttribute('href') || '';
          const asinMatch = href.match(/\/dp\/([A-Z0-9]+)/);
          const asin = asinMatch ? asinMatch[1] : '';

          if (asin && !seenAsins.has(asin)) {
            seenAsins.add(asin);
            order.asins.push(asin);
          }
        });

        // Combine titles with AND
        if (order.titles.length > 0) {
          order.title = order.titles.join(' AND ');
        }

        // Check if order has real tracking - if "View or edit order" button exists, tracking is not yet available
        const viewEditBtn = orderContainer.querySelector('a[href*="order-details"]');
        if (viewEditBtn && viewEditBtn.textContent.includes('View or edit order')) {
          order.hasRealTracking = false;
          order.status = 'Just Ordered'; // Override status for orders without tracking
        }

        // Extract price - find in parent order-card if not in delivery-box
        let priceContainer = orderContainer;

        // If we're in delivery-box, go up to order-card for the price
        if (!orderContainer.classList.contains('order-card')) {
          let parent = orderContainer.parentElement;
          while (parent && !parent.classList.contains('order-card')) {
            parent = parent.parentElement;
          }
          if (parent) {
            priceContainer = parent;
          }
        }

        // Look for price in the order header area
        const priceEls = priceContainer.querySelectorAll('.a-size-base.a-color-secondary.aok-break-word, .yohtmlc-order-total');
        priceEls.forEach(priceEl => {
          const text = priceEl.textContent.trim();
          const priceMatch = text.match(/^\$(\d+(?:,\d{3})*(?:\.\d{2})?)$/);
          if (priceMatch && order.totalPrice === 0) {
            order.totalPrice = parseFloat(priceMatch[1].replace(',', ''));
          }
        });

        // Also try finding price by searching all elements
        if (order.totalPrice === 0) {
          priceContainer.querySelectorAll('*').forEach(el => {
            if (order.totalPrice > 0) return;
            const text = el.textContent.trim();
            if (text.match(/^\$\d+\.\d{2}$/) && el.children.length === 0) {
              const val = parseFloat(text.replace('$', '').replace(',', ''));
              if (val > 0) {
                order.totalPrice = val;
              }
            }
          });
        }

        if (order.totalPrice > 0) {
          order.price = '$' + order.totalPrice.toFixed(2);
        }
      }

      // Filter out orders delivered more than 14 days ago
      if (order.status === 'Delivered' && order.deliveryDateRaw) {
        if (order.deliveryDateRaw < fourteenDaysAgo) {
          return;
        }
      }

      orders.push(order);
    });

    // Fallback: try alternative parsing if no track links found
    if (orders.length === 0) {
      return parseOrdersAlternative();
    }

    return orders;
  }

  function parseStatus(statusText) {
    const text = statusText.toLowerCase();

    if (text.includes('delivered')) {
      return 'Delivered';
    } else if (text.includes('out for delivery')) {
      return 'Out for delivery';
    } else if (text.includes('arriving today')) {
      return 'Arriving today';
    } else if (text.includes('arriving')) {
      return 'In transit';
    } else if (text.includes('shipped')) {
      return 'Shipped';
    } else if (text.includes('on the way')) {
      return 'In transit';
    } else if (text.includes('expected')) {
      return 'In transit';
    }

    return statusText;
  }

  function parseDeliveryDate(statusText) {
    // Try to extract date from status like "Delivered January 15" or "Arriving Wednesday"

    const months = {
      'january': 0, 'february': 1, 'march': 2, 'april': 3,
      'may': 4, 'june': 5, 'july': 6, 'august': 7,
      'september': 8, 'october': 9, 'november': 10, 'december': 11
    };

    // Pattern: look for month name followed by day number
    // "Delivered January 12" -> January 12
    // "Delivered Wednesday, January 15" -> January 15
    const dateMatch = statusText.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);

    if (dateMatch) {
      const monthStr = dateMatch[1].toLowerCase();
      const day = parseInt(dateMatch[2], 10);
      let year = dateMatch[3] ? parseInt(dateMatch[3], 10) : new Date().getFullYear();

      const month = months[monthStr];
      const date = new Date(year, month, day);

      // If date is in the future but we're talking about "delivered", it must be last year
      if (date > new Date() && statusText.toLowerCase().includes('delivered')) {
        date.setFullYear(date.getFullYear() - 1);
      }

      return date;
    }

    return null;
  }

  function findOrderContainer(element) {
    // Walk up the DOM to find the delivery-box (each shipment has its own delivery-box)
    let current = element.parentElement;
    let depth = 0;
    const maxDepth = 15;

    while (current && depth < maxDepth) {
      const className = current.className || '';

      // Find delivery-box - each shipment is a separate delivery
      if (className.includes('delivery-box') && !className.includes('primary-text')) {
        return current;
      }

      current = current.parentElement;
      depth++;
    }

    // Fallback
    return element.parentElement?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement;
  }

  function parseOrdersAlternative() {
    const orders = [];

    // Look for tracking links directly
    const trackingLinks = document.querySelectorAll('a[href*="track"]');

    trackingLinks.forEach(link => {
      const text = link.textContent || '';
      const href = link.href || '';

      // Find parent order container
      let orderContainer = link.closest('.a-box-group, .order-card, [class*="order"]');
      if (!orderContainer) {
        orderContainer = link.parentElement?.parentElement?.parentElement;
      }

      if (orderContainer) {
        const order = {
          orderId: '',
          title: '',
          trackingNumber: '',
          deliveryDate: '',
          status: 'Shipped',
          carrier: ''
        };

        // Extract tracking from link
        const trackMatch = text.match(/\b[A-Z0-9]{12,22}\b/) ||
                          href.match(/trackingId=([A-Z0-9]+)/i);
        if (trackMatch) {
          order.trackingNumber = trackMatch[1] || trackMatch[0];
        }

        // Extract order ID from container
        const containerText = orderContainer.textContent;
        const orderIdMatch = containerText.match(/\d{3}-\d{7}-\d{7}/);
        if (orderIdMatch) {
          order.orderId = orderIdMatch[0];
        }

        // Extract title
        const titleEl = orderContainer.querySelector('a[href*="/dp/"], .a-text-bold');
        if (titleEl) {
          order.title = titleEl.textContent.trim().substring(0, 100);
        }

        // Only add if we have a tracking number and it's not a duplicate
        if (order.trackingNumber && !orders.find(o => o.trackingNumber === order.trackingNumber)) {
          orders.push(order);
        }
      }
    });

    return orders;
  }

})();
