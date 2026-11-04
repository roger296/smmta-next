/**
 * The base layout every email shares (runbook section 7 step 1): header with
 * the store name, the body, and a footer with the trader's legal details, a
 * "why you got this" line, and — on marketing only — the unsubscribe and
 * preferences links. Inline styles only, 600 px wide, no web fonts.
 */
import * as React from 'react';
import { Body, Container, Head, Hr, Html, Link, Preview, Section, Text } from '@react-email/components';
import type { EmailClass } from '../../../db/schema/index.js';
import { COMPANY } from './company.js';

export const C = {
  paper: '#ECECE8',
  bone: '#F5F4F0',
  ink: '#15161A',
  muted: '#6B6E76',
  border: '#C7CCD1',
  accent: '#3B5266',
  white: '#FFFFFF',
} as const;

export const FONT = 'Arial, Helvetica, sans-serif';

export const text: React.CSSProperties = { margin: '0 0 14px', fontSize: '15px', lineHeight: '1.55', color: C.ink, fontFamily: FONT };
export const small: React.CSSProperties = { margin: '0 0 8px', fontSize: '12px', lineHeight: '1.5', color: C.muted, fontFamily: FONT };

export interface LayoutProps {
  preheader?: string | null;
  cls: EmailClass;
  /** Why this person is getting this email. */
  why: string;
  unsubscribeUrl?: string;
  preferencesUrl?: string;
  storeUrl: string;
  children: React.ReactNode;
}

export function Layout({ preheader, cls, why, unsubscribeUrl, preferencesUrl, storeUrl, children }: LayoutProps) {
  return (
    <Html lang="en-GB">
      <Head>
        <meta name="color-scheme" content="light" />
      </Head>
      {preheader ? <Preview>{preheader}</Preview> : null}
      <Body style={{ margin: 0, padding: '24px 0', backgroundColor: C.paper, fontFamily: FONT }}>
        <Container style={{ width: '100%', maxWidth: '600px', backgroundColor: C.white, border: `1px solid ${C.border}` }}>
          <Section style={{ padding: '20px 32px', borderBottom: `1px solid ${C.border}` }}>
            <Link href={storeUrl} style={{ color: C.ink, fontSize: '20px', fontWeight: 700, textDecoration: 'none', fontFamily: FONT }}>
              {COMPANY.tradingName}
            </Link>
          </Section>
          <Section style={{ padding: '28px 32px' }}>{children}</Section>
          <Hr style={{ borderColor: C.border, margin: 0 }} />
          <Section style={{ padding: '20px 32px', backgroundColor: C.bone }}>
            <Text style={small}>{why}</Text>
            {cls === 'marketing' && unsubscribeUrl ? (
              <Text style={small}>
                <Link href={unsubscribeUrl} style={{ color: C.accent }}>
                  Unsubscribe
                </Link>
                {preferencesUrl ? (
                  <>
                    {' · '}
                    <Link href={preferencesUrl} style={{ color: C.accent }}>
                      Email preferences
                    </Link>
                  </>
                ) : null}
              </Text>
            ) : null}
            <Text style={small}>
              {COMPANY.tradingName} is a trading name of {COMPANY.legalEntity}, registered in England and Wales,
              company number {COMPANY.companyNumber}. Registered office: {COMPANY.registeredAddress}. VAT{' '}
              {COMPANY.vatNumber}.
            </Text>
            <Text style={small}>
              Questions? Reply to this email or write to {COMPANY.contactEmail}.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
