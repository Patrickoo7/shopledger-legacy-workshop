var assert = require('node:assert/strict');
var test = require('node:test');
var config = require('../config');
var invoice = require('../lib/invoice');
var pricing = require('../lib/pricing');
var reports = require('../lib/reports');
var store = require('../lib/store');
var orderRoutes = require('../routes/orders');

test('checkout prorates a capped coupon before computing GST by HSN', function () {
  var items = [
    { id: 1, name: 'Rice', hsn: '1006', price: 600, qty: 2 },
    { id: 2, name: 'Butter', hsn: '0405', price: 800, qty: 1 }
  ];

  var totals = pricing.computeTotals(items, 'SAVE10');

  assert.deepEqual(totals, {
    subtotal: 2000,
    discount: 150,
    taxable: 1850,
    tax: 144.30,
    cgst: 72.15,
    sgst: 72.15,
    total: 1994.30,
    lines: [
      { id: 1, name: 'Rice', hsn: '1006', gstPercent: 5, gross: 1200, discount: 90, taxable: 1110, tax: 55.50, net: 1165.50 },
      { id: 2, name: 'Butter', hsn: '0405', gstPercent: 12, gross: 800, discount: 60, taxable: 740, tax: 88.80, net: 828.80 }
    ]
  });
});

test('a placed order prints the billed total and checkout GST breakdown', function (t) {
  var db = {
    products: [
      { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 600, stock: 10 },
      { id: 2, sku: 'BUTTER', name: 'Butter', hsn: '0405', price: 800, stock: 10 }
    ],
    orders: [],
    nextOrderId: 1
  };
  t.mock.method(store, 'read', function () { return db; });
  var write = t.mock.method(store, 'write', function () {});
  var status;
  var order;

  orderRoutes.handle({
    method: 'POST',
    url: '/orders',
    body: { items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }], coupon: 'SAVE10' }
  }, {
    status: function (code) { status = code; return this; },
    json: function (body) { order = body; }
  }, function (err) {
    assert.fail(err || 'Expected POST /orders to handle the request');
  });

  assert.equal(status, 201);
  assert.equal(write.mock.callCount(), 1);
  assert.equal(write.mock.calls[0].arguments[0].orders[0], order);
  assert.deepEqual([order.subtotal, order.discount, order.tax, order.total], [2000, 150, 144.30, 1994.30]);

  var figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures, {
    subtotal: 2000,
    discount: 150,
    tax: 144.30,
    cgst: 72.15,
    sgst: 72.15,
    total: 1994.30,
    rows: [
      { name: 'Rice', sku: 'RICE', hsn: '1006', qty: 2, price: 600, gstPercent: 5, line: 1200, lineTax: 55.50 },
      { name: 'Butter', sku: 'BUTTER', hsn: '0405', qty: 1, price: 800, gstPercent: 12, line: 800, lineTax: 88.80 }
    ]
  });

  var html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">\u20b9144\.30/);
  assert.match(html, /Invoice Total<\/td><td class="r">\u20b91994\.30/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
  assert.equal(reports.getGstReconciliation(db).rows[0].matched, true);
});

test('invoice excludes a stored flat coupon below the checkout minimum', function () {
  var items = [{ name: 'Tea', hsn: '0902', price: 20, qty: 1 }];
  var billed = pricing.computeTotals(items, 'FLAT50');
  var printed = invoice.computeInvoiceFigures({ items: items, coupon: 'FLAT50' });

  assert.deepEqual([billed.discount, billed.tax, billed.total], [0, 3.60, 23.60]);
  assert.deepEqual([printed.discount, printed.tax, printed.total], [0, 3.60, 23.60]);
});

test('invoice excludes an inactive coupon stored on an order', function () {
  var items = [{ name: 'Tea', hsn: '0902', price: 1000, qty: 1 }];
  var billed = pricing.computeTotals(items, 'DIWALI20');
  var printed = invoice.computeInvoiceFigures({ items: items, coupon: 'DIWALI20' });

  assert.deepEqual([billed.discount, billed.total], [0, 1180]);
  assert.deepEqual([printed.discount, printed.total], [0, 1180]);
});

test('invoice preserves the checkout discount after a coupon is deactivated', function (t) {
  var items = [{ name: 'Tea', hsn: '0902', price: 400, qty: 1 }];
  var billed = pricing.computeTotals(items, 'FLAT50');
  var order = { items: items, coupon: 'FLAT50', discount: billed.discount, total: billed.total };
  var coupon = config.coupons.FLAT50;
  var wasActive = coupon.active;
  t.after(function () { coupon.active = wasActive; });
  coupon.active = false;

  var printed = invoice.computeInvoiceFigures(order);

  assert.deepEqual([printed.discount, printed.rows[0].lineTax, printed.tax, printed.total], [50, 63, 63, 413]);
});

test('invoice uses checkout GST rates for decimal and zero overrides', function () {
  var items = [
    { name: 'Rice', hsn: '1006', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Butter', hsn: '0405', price: 100, qty: 1, gstRate: 0 }
  ];
  var billed = pricing.computeTotals(items);
  var printed = invoice.computeInvoiceFigures({ items: items });

  assert.deepEqual(billed.lines.map(function (line) { return [line.gstPercent, line.tax]; }), [[5, 5], [0, 0]]);
  assert.deepEqual(printed.rows.map(function (row) { return [row.gstPercent, row.lineTax]; }), [[5, 5], [0, 0]]);
  assert.deepEqual([printed.tax, printed.cgst, printed.sgst, printed.total], [5, 2.50, 2.50, 205]);
});

test('invoice sums rounded line GST and splits GST the same way as checkout', function () {
  var items = [
    { name: 'Rice A', price: 0.10, qty: 1, gstRate: 5 },
    { name: 'Rice B', price: 0.10, qty: 1, gstRate: 5 }
  ];
  var billed = pricing.computeTotals(items);
  var printed = invoice.computeInvoiceFigures({ items: items });

  assert.deepEqual(printed.rows.map(function (row) { return row.lineTax; }), [0.01, 0.01]);
  assert.deepEqual([billed.tax, billed.cgst, billed.sgst, billed.total], [0.02, 0.01, 0.01, 0.22]);
  assert.deepEqual([printed.tax, printed.cgst, printed.sgst, printed.total], [0.02, 0.01, 0.01, 0.22]);
});

test('CURRENT BEHAVIOUR: reconciliation flags a GST-only mismatch while the printed notice stays hidden', function () {
  var order = {
    id: 1,
    items: [{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }],
    subtotal: 100,
    discount: 0,
    tax: 17.99,
    total: 118
  };
  var result = reports.getGstReconciliation({ orders: [order] });
  var row = result.rows[0];

  assert.deepEqual([result.totalChecked, result.mismatchCount, result.totalDelta], [1, 1, 0]);
  assert.deepEqual([row.ledgerTax, row.invoiceTax, row.ledgerTotal, row.invoiceTotal], [17.99, 18, 118, 118]);
  assert.equal(row.delta, 0);
  assert.equal(row.matched, false);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('reconciliation skips cancelled orders and sums absolute differences in invoice totals', function () {
  var items = [{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }];
  var result = reports.getGstReconciliation({
    orders: [
      { id: 1, items: items, subtotal: 100, discount: 0, tax: 18, total: 115 },
      { id: 2, items: items, subtotal: 100, discount: 0, tax: 18, total: 120 },
      { id: 3, items: items, subtotal: 100, discount: 0, tax: 18, total: 118 },
      { id: 4, items: items, subtotal: 100, discount: 0, tax: 18, total: 90, status: 'cancelled' }
    ]
  });

  assert.deepEqual([result.totalChecked, result.mismatchCount, result.totalDelta], [3, 2, 5]);
  assert.deepEqual(result.rows.map(function (row) {
    return [row.orderId, row.delta, row.matched];
  }), [[1, 3, false], [2, -2, false], [3, 0, true]]);
});
