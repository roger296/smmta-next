/**
 * Content blocks (runbook section 7 step 2). A campaign's `content` — or a
 * send's `data.blocks` — is an ordered list of `{ type, props }`; each type
 * below renders one block. Every shop link goes through trackLink, so UTM
 * tags, the send id and interest keys are always there.
 */
import * as React from 'react';
import { Button, Column, Heading, Img, Link, Markdown, Row, Section, Text } from '@react-email/components';
import { C, FONT, small, text } from './layout.js';
import { cartLink, productUrl, storeUrl, trackLink, type LinkContext } from './links.js';

export interface BlockContext extends LinkContext {
  isTrade: boolean;
}

export interface ProductCard {
  productId: string;
  name: string;
  colour?: string | null;
  imageUrl?: string | null;
  priceGbp?: string | null;
  /** Shown only to trade contacts, and only when provided. */
  tradePriceGbp?: string | null;
  groupSlug?: string | null;
  slug?: string | null;
  interestKeys?: string[];
}

export interface BackInStockEntry {
  productId: string;
  productName: string;
  productSlug?: string | null;
  productImageUrl?: string | null;
  priceGbp?: string | null;
  colour?: string | null;
}

export type Block =
  | { type: 'Hero'; props: { heading: string; body?: string; imageUrl?: string; imageAlt?: string; ctaLabel?: string; ctaUrl?: string } }
  | { type: 'Text'; props: { body: string } }
  | { type: 'FeaturedText'; props: { heading?: string; markdown: string } }
  | { type: 'ProductGrid'; props: { title?: string; products: ProductCard[]; cta?: 'view' | 'add' } }
  | { type: 'BackInStockList'; props: { title?: string; items: BackInStockEntry[] } }
  | { type: 'DealsList'; props: { title?: string; deals: Array<{ title: string; description?: string; url?: string; priceGbp?: string; savingGbp?: string }> } }
  | { type: 'OrderSummary'; props: { orderNumber: string; lines: Array<{ name: string; quantity: number; lineTotalGbp: string }>; totalGbp: string } }
  | { type: 'CartContents'; props: { lines: Array<{ productId: string; name: string; colour?: string | null; imageUrl?: string | null; quantity: number; priceGbp?: string | null }>; stockNote?: string; checkoutUrl?: string } };

export type BlockType = Block['type'];
export const BLOCK_TYPES: BlockType[] = ['Hero', 'Text', 'FeaturedText', 'ProductGrid', 'BackInStockList', 'DealsList', 'OrderSummary', 'CartContents'];
/** Offers have no place in service mail (spec: "plain service content, no offers"). */
export const OFFER_BLOCKS: BlockType[] = ['DealsList', 'Hero'];

const h2: React.CSSProperties = { margin: '8px 0 14px', fontSize: '18px', lineHeight: '1.3', fontWeight: 700, color: C.ink, fontFamily: FONT };
const button: React.CSSProperties = {
  backgroundColor: C.ink,
  color: C.paper,
  padding: '13px 22px',
  fontSize: '13px',
  fontWeight: 600,
  letterSpacing: '1px',
  textTransform: 'uppercase',
  textDecoration: 'none',
  fontFamily: FONT,
};

function gbp(v?: string | null): string | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? `£${n.toFixed(2)}` : null;
}

function Hero({ p, ctx }: { p: Extract<Block, { type: 'Hero' }>['props']; ctx: BlockContext }) {
  return (
    <Section style={{ margin: '0 0 20px' }}>
      {p.imageUrl ? (
        <Img src={p.imageUrl} alt={p.imageAlt ?? p.heading} width="536" style={{ display: 'block', maxWidth: '100%', height: 'auto', margin: '0 0 16px', border: `1px solid ${C.border}` }} />
      ) : null}
      <Heading as="h1" style={{ ...h2, fontSize: '22px' }}>{p.heading}</Heading>
      {p.body ? <Text style={text}>{p.body}</Text> : null}
      {p.ctaUrl ? (
        <Button href={trackLink(p.ctaUrl, ctx)} style={button}>
          {p.ctaLabel ?? 'Shop now'}
        </Button>
      ) : null}
    </Section>
  );
}

function ProductGrid({ p, ctx }: { p: Extract<Block, { type: 'ProductGrid' }>['props']; ctx: BlockContext }) {
  const items = p.products.slice(0, 6);
  const rows: ProductCard[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <Section style={{ margin: '0 0 20px' }}>
      {p.title ? <Heading as="h2" style={h2}>{p.title}</Heading> : null}
      {rows.map((row, i) => (
        <Row key={i} style={{ marginBottom: '16px' }}>
          {row.map((prod) => {
            const view = trackLink(productUrl(prod), ctx, prod.interestKeys);
            const href = p.cta === 'add' ? trackLink(cartLink(prod.productId, 1, ctx.contactId), ctx, prod.interestKeys) : view;
            const trade = ctx.isTrade ? gbp(prod.tradePriceGbp) : null;
            return (
              <Column key={prod.productId} style={{ width: '50%', verticalAlign: 'top', padding: '0 8px 0 0' }}>
                {prod.imageUrl ? (
                  <Link href={view}>
                    <Img src={prod.imageUrl} alt={prod.colour ? `${prod.name} in ${prod.colour}` : prod.name} width="260" style={{ display: 'block', maxWidth: '100%', height: 'auto', border: `1px solid ${C.border}` }} />
                  </Link>
                ) : null}
                <Text style={{ ...text, margin: '8px 0 4px', fontWeight: 700 }}>
                  <Link href={view} style={{ color: C.ink, textDecoration: 'none' }}>
                    {prod.name}
                    {prod.colour ? ` — ${prod.colour}` : ''}
                  </Link>
                </Text>
                {gbp(prod.priceGbp) ? <Text style={{ ...small, color: C.ink }}>{gbp(prod.priceGbp)} inc. VAT</Text> : null}
                {trade ? <Text style={{ ...small, color: C.accent }}>{`Your trade price: ${trade}`}</Text> : null}
                <Link href={href} style={{ ...small, color: C.accent, textDecoration: 'underline' }}>
                  {p.cta === 'add' ? 'Add to basket' : 'View'}
                </Link>
              </Column>
            );
          })}
        </Row>
      ))}
    </Section>
  );
}

function BackInStockList({ p, ctx }: { p: Extract<Block, { type: 'BackInStockList' }>['props']; ctx: BlockContext }) {
  return (
    <Section style={{ margin: '0 0 20px' }}>
      {p.title ? <Heading as="h2" style={h2}>{p.title}</Heading> : null}
      {p.items.map((it) => {
        const name = `${it.productName}${it.colour ? ` in ${it.colour}` : ''}`;
        const view = trackLink(productUrl({ slug: it.productSlug, colour: it.colour }), ctx);
        return (
          <Section key={it.productId} style={{ margin: '0 0 18px' }}>
            {it.productImageUrl ? (
              <Img src={it.productImageUrl} alt={name} width="280" style={{ display: 'block', maxWidth: '100%', height: 'auto', margin: '0 0 12px', border: `1px solid ${C.border}` }} />
            ) : null}
            <Text style={{ ...text, margin: '0 0 6px' }}>
              <strong>{name}</strong> is available again — limited stock, so don&apos;t hang about.
            </Text>
            {gbp(it.priceGbp) ? <Text style={{ ...text, margin: '0 0 10px' }}><strong>{gbp(it.priceGbp)}</strong> · inc. VAT</Text> : null}
            <Button href={trackLink(cartLink(it.productId, 1, ctx.contactId), ctx)} style={button}>
              Add to basket
            </Button>
            <Text style={{ ...small, margin: '8px 0 0' }}>
              or <Link href={view} style={{ color: C.accent }}>view it in the shop</Link>
            </Text>
          </Section>
        );
      })}
    </Section>
  );
}

function DealsList({ p, ctx }: { p: Extract<Block, { type: 'DealsList' }>['props']; ctx: BlockContext }) {
  return (
    <Section style={{ margin: '0 0 20px' }}>
      <Heading as="h2" style={h2}>{p.title ?? 'Current deals'}</Heading>
      {p.deals.map((d, i) => (
        <Text key={i} style={text}>
          {d.url ? <Link href={trackLink(d.url, ctx)} style={{ color: C.ink, fontWeight: 700 }}>{d.title}</Link> : <strong>{d.title}</strong>}
          {d.description ? ` — ${d.description}` : ''}
          {gbp(d.priceGbp) ? ` ${gbp(d.priceGbp)}` : ''}
          {gbp(d.savingGbp) ? ` (save ${gbp(d.savingGbp)})` : ''}
        </Text>
      ))}
    </Section>
  );
}

function OrderSummary({ p }: { p: Extract<Block, { type: 'OrderSummary' }>['props'] }) {
  return (
    <Section style={{ margin: '0 0 20px', border: `1px solid ${C.border}`, padding: '12px 16px' }}>
      <Text style={{ ...text, fontWeight: 700 }}>Order {p.orderNumber}</Text>
      {p.lines.map((l, i) => (
        <Text key={i} style={{ ...small, color: C.ink }}>
          {l.quantity} × {l.name} — {gbp(l.lineTotalGbp)}
        </Text>
      ))}
      <Text style={{ ...text, margin: '8px 0 0', fontWeight: 700 }}>Total {gbp(p.totalGbp)}</Text>
    </Section>
  );
}

function CartContents({ p, ctx }: { p: Extract<Block, { type: 'CartContents' }>['props']; ctx: BlockContext }) {
  return (
    <Section style={{ margin: '0 0 20px' }}>
      {p.lines.map((l) => (
        <Row key={l.productId} style={{ marginBottom: '10px' }}>
          {l.imageUrl ? (
            <Column style={{ width: '90px', verticalAlign: 'top' }}>
              <Img src={l.imageUrl} alt={l.name} width="80" style={{ display: 'block', border: `1px solid ${C.border}` }} />
            </Column>
          ) : null}
          <Column style={{ verticalAlign: 'top' }}>
            <Text style={{ ...text, margin: '0 0 4px' }}>
              {l.quantity} × <strong>{l.name}</strong>
              {l.colour ? ` — ${l.colour}` : ''}
            </Text>
            {gbp(l.priceGbp) ? <Text style={small}>{gbp(l.priceGbp)} each, inc. VAT</Text> : null}
          </Column>
        </Row>
      ))}
      {p.stockNote ? <Text style={{ ...text, color: C.accent }}>{p.stockNote}</Text> : null}
      <Button href={trackLink(p.checkoutUrl ?? storeUrl('/cart'), ctx)} style={button}>
        Back to your basket
      </Button>
    </Section>
  );
}

export function renderBlock(block: Block, ctx: BlockContext, key: number): React.ReactNode {
  switch (block.type) {
    case 'Hero':
      return <Hero key={key} p={block.props} ctx={ctx} />;
    case 'Text':
      return block.props.body.split(/\n{2,}/).map((para, i) => <Text key={`${key}-${i}`} style={text}>{para}</Text>);
    case 'FeaturedText':
      return (
        <Section key={key} style={{ margin: '0 0 20px' }}>
          {block.props.heading ? <Heading as="h2" style={h2}>{block.props.heading}</Heading> : null}
          <Markdown markdownContainerStyles={{ fontFamily: FONT, fontSize: '15px', lineHeight: '1.55', color: C.ink }} markdownCustomStyles={{ link: { color: C.accent }, p: { margin: '0 0 12px' } }}>
            {block.props.markdown}
          </Markdown>
        </Section>
      );
    case 'ProductGrid':
      return <ProductGrid key={key} p={block.props} ctx={ctx} />;
    case 'BackInStockList':
      return <BackInStockList key={key} p={block.props} ctx={ctx} />;
    case 'DealsList':
      return <DealsList key={key} p={block.props} ctx={ctx} />;
    case 'OrderSummary':
      return <OrderSummary key={key} p={block.props} />;
    case 'CartContents':
      return <CartContents key={key} p={block.props} ctx={ctx} />;
    default:
      return null;
  }
}
