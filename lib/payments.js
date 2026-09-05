// Wraps Paddle Billing for course payments — same provider ReqDrive already
// uses, following the same env var conventions (PADDLE_API_KEY,
// PADDLE_CLIENT_TOKEN, PADDLE_ENVIRONMENT, PADDLE_WEBHOOK_SECRET).
//
// Courses have admin-configurable, per-course dynamic pricing (base price +
// a discount percentage), which doesn't map to a fixed subscription catalog
// the way ReqDrive's own plans do. Paddle supports this directly via
// "non-catalog" transaction items — an inline price + product object, with
// no pre-created Price/Product IDs required. Paddle creates ephemeral
// entities for these automatically. Reference:
// https://developer.paddle.com/build/transactions/bill-create-custom-items-prices-products

function isConfigured() {
  return !!(process.env.PADDLE_API_KEY && process.env.PADDLE_CLIENT_TOKEN);
}

function paddleApiBaseUrl() {
  const env = (process.env.PADDLE_ENVIRONMENT || "sandbox").toLowerCase();
  return env === "production" || env === "live"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";
}

function getClientConfig() {
  const env = (process.env.PADDLE_ENVIRONMENT || "sandbox").toLowerCase();
  return {
    clientToken: process.env.PADDLE_CLIENT_TOKEN || null,
    environment: env === "production" || env === "live" ? "production" : "sandbox",
  };
}

function finalPriceCents(course) {
  const discount = course.discountPercent || 0;
  return Math.round(course.priceCents * (1 - discount / 100));
}

// Creates a draft Paddle transaction with a non-catalog (inline) price for
// this specific registration's amount. Returns the transaction id, which
// the client-side Paddle.js checkout overlay opens against.
async function createTransaction({ course, registration }) {
  if (!isConfigured()) return { configured: false };

  const amount = finalPriceCents(course);

  const body = {
    items: [
      {
        quantity: 1,
        price: {
          description: `${course.title} — course registration`,
          name: course.title,
          unit_price: {
            amount: String(amount),
            currency_code: (course.currency || "USD").toUpperCase(),
          },
          product: {
            name: course.title,
            tax_category: "standard",
            description: course.summary || course.title,
          },
        },
      },
    ],
    currency_code: (course.currency || "USD").toUpperCase(),
    customer_email: registration.email,
    custom_data: {
      registrationId: registration.id,
      courseId: course.id,
    },
  };

  const res = await fetch(`${paddleApiBaseUrl()}/transactions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("[paddle] transaction creation failed:", res.status, errText);
    throw new Error(`Paddle transaction creation failed (${res.status})`);
  }

  const json = await res.json();
  return { configured: true, transactionId: json.data.id };
}

module.exports = { isConfigured, createTransaction, finalPriceCents, getClientConfig };
