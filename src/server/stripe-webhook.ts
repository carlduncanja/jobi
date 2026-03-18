import Stripe from 'stripe';

import type { AppContext } from '../lib/app-context';
import { getPaymentBySession, markPaymentPaid } from '../db/store';

/**
 * Handle POST /webhooks/stripe
 *
 * Stripe sends a signed event payload. We verify the signature, then act on
 * checkout.session.completed to mark the payment as paid and notify the user
 * on WhatsApp so they know their review is ready.
 */
export async function handleStripeWebhook(app: AppContext, req: Request): Promise<Response> {
  const webhookSecret = app.env.stripe.webhookSecret;
  const stripeKey = app.env.stripe.secretKey;

  if (!stripeKey || !webhookSecret) {
    app.logger.warn('Stripe webhook received but STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET not set');
    return Response.json({ error: 'not configured' }, { status: 503 });
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return Response.json({ error: 'missing stripe-signature header' }, { status: 400 });
  }

  const rawBody = await req.text();
  const stripe = new Stripe(stripeKey);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    app.logger.warn({ err }, 'Stripe webhook signature verification failed');
    return Response.json({ error: 'invalid signature' }, { status: 400 });
  }

  app.logger.info({ type: event.type }, 'Stripe webhook received');

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    await handleCheckoutCompleted(app, session);
  }

  return Response.json({ received: true });
}

async function handleCheckoutCompleted(
  app: AppContext,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id ?? '';

  const payment = await markPaymentPaid(app.db, session.id, paymentIntentId);

  if (!payment) {
    // Could be a session we don't know about (e.g. manual test)
    app.logger.warn({ sessionId: session.id }, 'Stripe checkout completed but no matching payment record');
    return;
  }

  app.logger.info(
    { userId: payment.userId, product: payment.product, sessionId: session.id },
    'Payment marked as paid',
  );

  // Notify the user on WhatsApp
  if (app.whatsappProvider) {
    const message = buildConfirmationMessage(payment.product);
    try {
      await app.whatsappProvider.sendText({
        chatId: payment.chatId,
        text: message,
      });
    } catch (err) {
      app.logger.error({ err, chatId: payment.chatId }, 'Failed to send payment confirmation on WhatsApp');
    }
  }
}

function buildConfirmationMessage(product: string): string {
  switch (product) {
    case 'resume_review':
      return "payment confirmed ✅ give me a sec and i'll send your full resume review with fixes right now 📄";
    default:
      return "payment confirmed ✅ thanks! i'll get that sorted for you now.";
  }
}
