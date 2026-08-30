import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown } from 'lucide-react'
import Navbar from '../components/Navbar'

// Shared shell — Navbar + centred column. The Footer is mounted globally in
// App.jsx, so pages don't render it themselves.
function PageShell({ title, subtitle, maxWidth = 760, children }) {
    useEffect(() => { window.scrollTo(0, 0) }, [])
    return (
        <>
            <Navbar />
            <main className="wrap" style={{ maxWidth, margin: '0 auto', padding: '80px 18px 40px' }}>
                <h1 style={{ fontSize: '1.4rem', fontWeight: 900, color: 'var(--bright)', letterSpacing: '-0.03em' }}>{title}</h1>
                {subtitle && (
                    <p style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: '6px 0 20px' }}>{subtitle}</p>
                )}
                <div style={{ fontSize: '0.86rem', lineHeight: 1.75, color: 'var(--accent)' }}>
                    {children}
                </div>
                <p style={{ marginTop: 28 }}>
                    <Link to="/" style={{ color: 'var(--pop)', fontSize: '0.8rem', textDecoration: 'none' }}>← Back to Vloombox</Link>
                </p>
            </main>
        </>
    )
}

function ComingSoon() {
    return (
        <p style={{
            padding: '14px 16px', border: '1px dashed var(--subtle)', borderRadius: 8,
            color: 'var(--muted)', fontSize: '0.82rem', background: 'var(--surface-2)',
        }}>
            Content coming soon.
        </p>
    )
}

function SectionHeader({ children }) {
    return (
        <h2 style={{
            fontSize: '0.95rem', fontWeight: 900, color: 'var(--bright)',
            margin: '22px 0 8px', letterSpacing: '-0.01em',
        }}>
            {children}
        </h2>
    )
}

// ── /about ────────────────────────────────────────────────────────
export function AboutPage() {
    return (
        <PageShell title="About Us" subtitle="Who we are and what Vloombox is for.">
            {/* TODO: real company / mission / team copy. Do not invent details. */}
            <ComingSoon />
        </PageShell>
    )
}

// ── /blog ─────────────────────────────────────────────────────────
export function BlogPage() {
    return (
        <PageShell title="Blog" subtitle="Interview prep, system design and resume tips.">
            {/* TODO: wire this to the `blogs` table + /blog/[slug] detail pages. */}
            <ComingSoon />
        </PageShell>
    )
}

// ── /questions ────────────────────────────────────────────────────
export function QuestionsPage() {
    return (
        <PageShell title="Question Bank" subtitle="Curated interview questions across topics.">
            {/* TODO: decide whether this is a new public catalogue or should
                redirect signed-in users to the existing /interview panel. */}
            <ComingSoon />
        </PageShell>
    )
}

// ── /legal/guidelines ────────────────────────────────────────────
export function GuidelinesPage() {
    return (
        <PageShell title="Community Guidelines" subtitle="Rules for the referral marketplace and shared content.">
            {/* TODO: real community guidelines copy. */}
            <ComingSoon />
        </PageShell>
    )
}

// ── /legal/privacy (scaffold — section headers only) ─────────────
export function LegalPrivacyScaffold() {
    return (
        <PageShell title="Privacy Policy">
            {/* NOTE: a separate, Razorpay-facing Privacy Policy with full copy
                lives at /privacy. This scaffold is the structure to be filled in. */}
            <SectionHeader>Data We Collect</SectionHeader>
            {/* TODO: describe account data, profile data, uploaded content, payment metadata, analytics. */}

            <SectionHeader>How We Use It</SectionHeader>
            {/* TODO: purposes of processing. */}

            <SectionHeader>Resume &amp; PII Handling</SectionHeader>
            {/* TODO: how resume files / extracted text are stored, processed by AI, retained, and deleted. */}

            <SectionHeader>Third-Party Sharing</SectionHeader>
            {/* TODO: sub-processors (Supabase, Razorpay, Gemini, Resend, PostHog) and what each receives. */}

            <SectionHeader>Your Rights / Data Deletion</SectionHeader>
            {/* TODO: access, correction, export, deletion; how to request. */}
        </PageShell>
    )
}

// ── /legal/terms (scaffold — section headers only) ──────────────
export function LegalTermsScaffold() {
    return (
        <PageShell title="Terms of Service">
            {/* NOTE: a separate, Razorpay-facing Terms & Conditions with full copy
                lives at /terms. This scaffold is the structure to be filled in. */}
            <SectionHeader>Acceptable Use</SectionHeader>
            {/* TODO: permitted / prohibited use, usage limits, scraping, resale. */}

            <SectionHeader>Referral Disclaimer</SectionHeader>
            {/* TODO: Vloombox does not guarantee referrals, interviews or outcomes; referrers act independently. */}

            <SectionHeader>Account Termination</SectionHeader>
            {/* TODO: grounds for suspension/termination, effect on paid plans. */}

            <SectionHeader>Liability</SectionHeader>
            {/* TODO: warranty disclaimer and limitation of liability. */}
        </PageShell>
    )
}

// ── /faq (accordion — starter questions, answers to be filled in) ─
const FAQ_ITEMS = [
    { q: 'How does referral verification work?', a: '' },       // TODO: answer
    { q: 'Is my resume shared with anyone besides the referrer?', a: '' }, // TODO: answer
    { q: 'Can I delete my referral post after posting?', a: '' }, // TODO: answer
    { q: 'How long does a referral request stay open?', a: '' },  // TODO: answer
]

function FaqRow({ item, open, onToggle }) {
    return (
        <div style={{ borderBottom: '1px solid var(--subtle)' }}>
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                    padding: '14px 4px', background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--bright)', fontSize: '0.9rem', fontWeight: 700, textAlign: 'left',
                    fontFamily: 'inherit',
                }}
            >
                <span style={{ flex: 1 }}>{item.q}</span>
                <ChevronDown
                    size={18}
                    style={{
                        flexShrink: 0, color: 'var(--muted)',
                        transform: open ? 'rotate(180deg)' : 'none',
                        transition: 'transform var(--transition)',
                    }}
                />
            </button>
            {open && (
                <div style={{ padding: '0 4px 16px', fontSize: '0.84rem', lineHeight: 1.7, color: 'var(--accent)' }}>
                    {item.a
                        ? item.a
                        : <span style={{ color: 'var(--faint)', fontStyle: 'italic' }}>Answer coming soon.{/* TODO: fill in */}</span>}
                </div>
            )}
        </div>
    )
}

export function FAQPage() {
    const [openIdx, setOpenIdx] = useState(0)
    return (
        <PageShell title="Frequently Asked Questions" subtitle="Common questions about referrals and your data.">
            <div>
                {FAQ_ITEMS.map((item, i) => (
                    <FaqRow
                        key={item.q}
                        item={item}
                        open={openIdx === i}
                        onToggle={() => setOpenIdx(openIdx === i ? -1 : i)}
                    />
                ))}
            </div>
            <p style={{ marginTop: 18, fontSize: '0.78rem', color: 'var(--faint)' }}>
                Still stuck? <Link to="/contact" style={{ color: 'var(--pop)' }}>Contact us</Link>.
            </p>
        </PageShell>
    )
}
