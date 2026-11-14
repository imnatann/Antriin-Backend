'use strict';

const { id, NAMESPACE } = require('../lib/ids.cjs');

const CAMPUS_ID = id(NAMESPACE.campus, 1);
const TENANT_ID = id(NAMESPACE.tenant, 1);

const campus = {
  id: CAMPUS_ID,
  name: 'Kampus Demo Antriin',
  timezone: 'Asia/Jakarta',
  emailDomain: 'demo.ac.id',
};

const tenant = {
  id: TENANT_ID,
  name: 'Kantin Demo Sehat',
  location: 'Gedung A, Lantai 1',
  status: 'open',
  opensAt: '07:00',
  closesAt: '21:00',
  closedWeekdays: [0],
};

const PERMISSIONS = Object.freeze({
  tenantOwner: [
    'tenant.orders.read',
    'tenant.orders.accept',
    'tenant.orders.prepare',
    'tenant.orders.handover',
    'tenant.orders.pause',
    'tenant.menu.manage',
    'tenant.capacity.manage',
    'tenant.staff.manage',
    'tenant.reviews.reply',
    'tenant.incidents.report',
    'tenant.sales.read',
    'tenant.finance.read',
    'tenant.bank_account.manage',
    'tenant.payout.request',
  ],
  tenantKitchen: [
    'tenant.orders.read',
    'tenant.orders.accept',
    'tenant.orders.prepare',
    'tenant.orders.pause',
    'tenant.menu.manage',
    'tenant.capacity.manage',
    'tenant.reviews.reply',
    'tenant.incidents.report',
  ],
  tenantPickup: [
    'tenant.orders.read',
    'tenant.orders.handover',
    'tenant.incidents.report',
  ],
  campusAdmin: [
    'campus.transactions.read',
    'campus.tenants.manage',
    'campus.access.manage',
    'campus.reviews.moderate',
    'campus.cases.read',
    'campus.cases.decide',
    'campus.refunds.initiate',
    'campus.payouts.read',
    'campus.ai_reviews.decide',
    'campus.audit.read',
  ],
});

/**
 * `email` is the login identity. Only `campusEmail` accounts get a verified
 * campus email, which reviews and campus-scoped flows require.
 * `phone` is an optional second login identity (E.164); demo numbers only.
 * `fundMinor` is demo wallet balance in IDR minor units (Rp 1 = 100).
 */
const accounts = [
  {
    key: 'buyer',
    displayName: 'Pembeli Demo',
    email: 'pembeli@demo.ac.id',
    phone: '+6281200000001',
    campusEmail: true,
    fundMinor: 20000000,
  },
  {
    key: 'owner',
    displayName: 'Pemilik Tenant Demo',
    email: 'pemilik@antriin.demo',
    phone: '+6281200000002',
    campusEmail: false,
  },
  {
    key: 'kitchen',
    displayName: 'Staf Dapur Demo',
    email: 'dapur@antriin.demo',
    phone: '+6281200000003',
    campusEmail: false,
  },
  {
    key: 'pickup',
    displayName: 'Staf Pengambilan Demo',
    email: 'pickup@antriin.demo',
    phone: '+6281200000004',
    campusEmail: false,
  },
  {
    key: 'campus_admin',
    displayName: 'Admin Kampus Demo',
    email: 'admin@demo.ac.id',
    phone: '+6281200000005',
    campusEmail: true,
  },
].map((account, index) => ({ ...account, id: id(NAMESPACE.user, index + 1) }));

const tenantMemberships = [
  {
    accountKey: 'owner',
    role: 'owner',
    permissions: PERMISSIONS.tenantOwner,
    ownerVerified: true,
  },
  {
    accountKey: 'kitchen',
    role: 'kitchen',
    permissions: PERMISSIONS.tenantKitchen,
    ownerVerified: false,
  },
  {
    accountKey: 'pickup',
    role: 'pickup',
    permissions: PERMISSIONS.tenantPickup,
    ownerVerified: false,
  },
];

const campusMemberships = [
  { accountKey: 'campus_admin', permissions: PERMISSIONS.campusAdmin },
];

const menu = [
  {
    key: 'geprek',
    categoryKey: 'food',
    name: 'Nasi Ayam Geprek',
    description: 'Ayam goreng tepung, sambal bawang, nasi hangat.',
    priceMinor: '1500000',
    optionGroup: {
      key: 'spice',
      name: 'Level Pedas',
      minSelections: 1,
      maxSelections: 1,
      choices: [
        { key: 'mild', name: 'Tidak pedas', priceDeltaMinor: '0' },
        { key: 'medium', name: 'Sedang', priceDeltaMinor: '0' },
        { key: 'hot', name: 'Pedas', priceDeltaMinor: '0' },
        { key: 'extreme', name: 'Pedas maksimal', priceDeltaMinor: '200000' },
      ],
    },
  },
  {
    key: 'mie',
    categoryKey: 'food',
    name: 'Mie Ayam Bakso',
    description: 'Mie ayam kampung dengan dua bakso sapi.',
    priceMinor: '1200000',
  },
  {
    key: 'tea',
    categoryKey: 'drink',
    name: 'Es Teh Manis',
    description: 'Teh tubruk, gula batu, es batu.',
    priceMinor: '400000',
  },
  {
    key: 'coffee',
    categoryKey: 'drink',
    name: 'Kopi Susu Gula Aren',
    description: 'Espresso, susu segar, gula aren.',
    priceMinor: '900000',
  },
].map((item, index) => ({
  ...item,
  id: id(NAMESPACE.menuItem, index + 1),
  categoryId:
    item.categoryKey === 'food'
      ? id(NAMESPACE.category, 1)
      : id(NAMESPACE.category, 2),
}));

const categories = [
  {
    id: id(NAMESPACE.category, 1),
    key: 'food',
    name: 'Makanan Utama',
    sortOrder: 1,
  },
  {
    id: id(NAMESPACE.category, 2),
    key: 'drink',
    name: 'Minuman',
    sortOrder: 2,
  },
];

/** Open pickup slots for the next `days` days, at the given local hours. */
const slots = {
  days: 4,
  hours: [11, 12, 13, 14, 15, 16],
  capacity: 10,
};

module.exports = {
  campus,
  tenant,
  accounts,
  tenantMemberships,
  campusMemberships,
  categories,
  menu,
  slots,
};
