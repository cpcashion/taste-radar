// Stripe helpers for Radar Pro ($1/month). Disabled when STRIPE_SECRET_KEY is unset.
const db = require('./db');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return require('stripe')(key);
}

const isEnabled = () => !!process.env.STRIPE_SECRET_KEY;

// Returns the $1/month recurring price id: env override, cached id, or created on first use.
async function getPriceId() {
  if (process.env.STRIPE_PRICE_ID) return process.env.STRIPE_PRICE_ID;
  const cached = db.getMeta('stripe_price_id');
  if (cached) return cached;
  const stripe = getStripe();
  if (!stripe) throw new Error('stripe_not_configured');
  const product = await stripe.products.create({ name: 'Radar Pro' });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: 100,
    currency: 'usd',
    recurring: { interval: 'month' },
    nickname: 'Radar Pro Monthly',
  });
  db.setMeta('stripe_price_id', price.id);
  return price.id;
}

module.exports = { getStripe, isEnabled, getPriceId };
