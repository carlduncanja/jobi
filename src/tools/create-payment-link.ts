import Stripe from 'stripe';
import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import { createPayment, getResumeProfile, hasPaidForProduct } from '../db/store';

// $500 JMD ≈ $3.25 USD — we bill in USD cents via Stripe
// Adjust PRICE_USD_CENTS if the JMD/USD rate changes significantly.
const PRODUCTS = {
  resume_review: {
    name: 'Jobi Resume Review',
    description: 'Full resume review with actionable fixes from Jobi',
    priceUsdCents: 325, // ~$500 JMD
    label: '$500 JMD',
  },
} as const;

export type ProductKey = keyof typeof PRODUCTS;

export function createPaymentLinkTool(app: AppContext, request: MainAgentRequestContext) {
  return tool({
    description:
      'Create a Stripe checkout link for a paid product (e.g. resume review) and send it to the user. ' +
      'Use this after the user agrees to pay.',
    inputSchema: zodSchema(
      z.object({
        product: z.enum(['resume_review']).describe('Which product to charge for'),
      }),
    ),
    execute: async ({ product }) => {
      const stripeKey = app.env.stripe.secretKey;
      if (!stripeKey) {
        app.logger.warn('STRIPE_SECRET_KEY not set — payment links disabled');
        return { error: 'payments not configured' };
      }

      // Don't charge someone who already paid for this product
      const alreadyPaid = await hasPaidForProduct(app.db, request.userId, product);
      if (alreadyPaid) {
        app.logger.info(
          { userId: request.userId, product },
          'User already paid for product — skipping new checkout session',
        );
        return { alreadyPaid: true, product };
      }

      // Resume review requires a resume on file
      if (product === 'resume_review') {
        const profile = await getResumeProfile(app.db, request.userId);
        if (!profile) {
          return { error: 'no_resume', message: 'no resume on file — ask the user to send their resume first' };
        }
      }

      const stripe = new Stripe(stripeKey);
      const meta = PRODUCTS[product];

      const successUrl =
        `${app.env.publicUrl || 'https://jobi.app'}/payment/success` +
        `?session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl =
        `${app.env.publicUrl || 'https://jobi.app'}/payment/cancel`;

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: meta.priceUsdCents,
              product_data: {
                name: meta.name,
                description: meta.description,
              },
            },
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          userId: request.userId,
          chatId: request.chatId,
          product,
        },
      });

      await createPayment(app.db, {
        userId: request.userId,
        chatId: request.chatId,
        stripeSessionId: session.id,
        product,
        amountUsd: meta.priceUsdCents / 100,
        status: 'pending',
      });

      app.logger.info(
        { userId: request.userId, product, sessionId: session.id },
        'Stripe checkout session created',
      );

      return {
        url: session.url,
        product,
        price: meta.label,
        sessionId: session.id,
      };
    },
  });
}
