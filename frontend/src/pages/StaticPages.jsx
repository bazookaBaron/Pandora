import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import Navbar from '../components/Navbar'
import MarkdownRenderer from '../components/interview/MarkdownRenderer'
import { LoadingState, ErrorState, EmptyState } from '../components/shared/states'
import { apiFetch } from '../lib/apiClient'
import { useEntitlements } from '../lib/useEntitlements'
import { BIZ } from './LegalPages'
import { VLOOMBOX_BLURB, VLOOMBOX_ABOUT, VLOOMBOX_FEATURES } from '../lib/brand'

function fmtDate(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

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
        <PageShell title="About Vloombox" subtitle={VLOOMBOX_BLURB}>
            {VLOOMBOX_ABOUT.map((para, i) => (
                <p key={i} style={{ margin: '0 0 14px' }}>{para}</p>
            ))}

            <SectionHeader>What&rsquo;s inside</SectionHeader>
            <ul style={{ margin: '0 0 14px', paddingLeft: 20 }}>
                {VLOOMBOX_FEATURES.map(([name, desc]) => (
                    <li key={name} style={{ marginBottom: 4 }}>
                        <strong style={{ color: 'var(--bright)' }}>{name}</strong> — {desc}
                    </li>
                ))}
            </ul>

            <SectionHeader>Who runs it</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                Vloombox is a small, independent project, built and actively maintained.
                Bugs, questions and feature requests are welcome at{' '}
                <a href={`mailto:${BIZ.email}`} style={{ color: 'var(--pop)' }}>{BIZ.email}</a>, or from the
                Feedback section of your profile once you&rsquo;re signed in.
            </p>
        </PageShell>
    )
}

// ── /blog — list of published posts ───────────────────────────────
export function BlogPage() {
    const { data, isLoading, error, refetch } = useQuery({
        queryKey: ['blog-list'],
        queryFn: () => apiFetch('/api/blog'),
        staleTime: 5 * 60_000,
    })
    const posts = data?.posts || []

    return (
        <PageShell title="Blog" subtitle="Interview prep, system design and resume tips.">
            {isLoading ? (
                <LoadingState label="Loading posts…" />
            ) : error ? (
                <ErrorState err={error} onRetry={refetch} />
            ) : posts.length === 0 ? (
                <EmptyState icon="📝" title="No posts yet" message="Check back soon." />
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {posts.map((p) => (
                        <Link
                            key={p.slug}
                            to={`/blog/${encodeURIComponent(p.slug)}`}
                            style={{
                                display: 'block', textDecoration: 'none',
                                background: 'var(--panel)', border: '1px solid var(--subtle)',
                                borderRadius: 10, padding: '16px 18px',
                            }}
                        >
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
                                {p.category && (
                                    <span style={{
                                        fontSize: '0.6rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em',
                                        color: 'var(--pop)', border: '1px solid var(--subtle)', borderRadius: 999, padding: '2px 8px',
                                    }}>{p.category}</span>
                                )}
                                <span style={{ fontSize: '0.7rem', color: 'var(--faint)' }}>
                                    {fmtDate(p.published_at)}
                                    {p.reading_time_minutes ? ` · ${p.reading_time_minutes} min read` : ''}
                                </span>
                            </div>
                            <div style={{ fontWeight: 900, fontSize: '1rem', color: 'var(--bright)', letterSpacing: '-0.01em' }}>
                                {p.title}
                            </div>
                            {p.excerpt && (
                                <p style={{ margin: '6px 0 0', fontSize: '0.84rem', color: 'var(--muted)', lineHeight: 1.6 }}>{p.excerpt}</p>
                            )}
                        </Link>
                    ))}
                </div>
            )}
        </PageShell>
    )
}

// ── /blog/:slug — single post ─────────────────────────────────────
export function BlogPostPage() {
    const { slug } = useParams()
    const { data, isLoading, error, refetch } = useQuery({
        queryKey: ['blog-post', slug],
        queryFn: () => apiFetch('/api/blog/' + encodeURIComponent(slug)),
        staleTime: 5 * 60_000,
        retry: (n, e) => (e && e.status === 404 ? false : n < 1),
    })
    const post = data?.post

    return (
        <PageShell title={post?.title || 'Blog'} subtitle={post ? `${fmtDate(post.published_at)}${post.reading_time_minutes ? ` · ${post.reading_time_minutes} min read` : ''}` : ''}>
            <p style={{ marginBottom: 16 }}>
                <Link to="/blog" style={{ color: 'var(--pop)', fontSize: '0.8rem', textDecoration: 'none' }}>← All posts</Link>
            </p>
            {isLoading ? (
                <LoadingState label="Loading…" />
            ) : error ? (
                error.status === 404
                    ? <EmptyState icon="🔍" title="Post not found" message="This article doesn’t exist or isn’t published." />
                    : <ErrorState err={error} onRetry={refetch} />
            ) : (
                <div className="markdown-body" style={{ fontSize: '0.9rem', lineHeight: 1.8 }}>
                    <MarkdownRenderer>{post.content || ''}</MarkdownRenderer>
                </div>
            )}
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
        <PageShell title="Community Guidelines" subtitle="How to use the referral board and anything you share on Vloombox.">
            <p style={{ margin: '0 0 14px' }}>
                The referral board only works if people trust it. These guidelines apply to referral
                requests, the company and role details on your profile, feedback you send, and anything
                else you post. They sit alongside our{' '}
                <Link to="/terms" style={{ color: 'var(--pop)' }}>Terms & Conditions</Link>.
            </p>

            <SectionHeader>Be honest</SectionHeader>
            <ul style={{ margin: '0 0 14px', paddingLeft: 20 }}>
                <li style={{ marginBottom: 4 }}>Only list a company as your current employer if you actually work there.</li>
                <li style={{ marginBottom: 4 }}>Only request a referral for a role you genuinely want and are reasonably qualified for.</li>
                <li style={{ marginBottom: 4 }}>Don&rsquo;t misrepresent your experience, seniority or the job you&rsquo;re targeting.</li>
            </ul>

            <SectionHeader>Keep it respectful</SectionHeader>
            <ul style={{ margin: '0 0 14px', paddingLeft: 20 }}>
                <li style={{ marginBottom: 4 }}>No spam, mass-posting, or re-posting the same request over and over.</li>
                <li style={{ marginBottom: 4 }}>No harassment, discrimination or abusive language toward other members.</li>
                <li style={{ marginBottom: 4 }}>A referral is always the other person&rsquo;s choice — don&rsquo;t pressure anyone for one.</li>
            </ul>

            <SectionHeader>No paying for referrals</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                Referrals on Vloombox are a favour between peers. Do not offer, request or accept money,
                gifts or any other consideration in exchange for a referral. Accounts that do will be removed.
            </p>

            <SectionHeader>Respect privacy</SectionHeader>
            <ul style={{ margin: '0 0 14px', paddingLeft: 20 }}>
                <li style={{ marginBottom: 4 }}>A résumé shared with you through a referral request is for evaluating that request only — don&rsquo;t forward, publish or reuse it.</li>
                <li style={{ marginBottom: 4 }}>Don&rsquo;t post other people&rsquo;s personal information.</li>
            </ul>

            <SectionHeader>Enforcement</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                We may hide content, close requests, or suspend or terminate accounts that break these
                guidelines. To report something, email{' '}
                <a href={`mailto:${BIZ.email}`} style={{ color: 'var(--pop)' }}>{BIZ.email}</a>.
            </p>
        </PageShell>
    )
}

// ── /legal/privacy — short summary; full policy lives at /privacy ─
export function LegalPrivacyScaffold() {
    return (
        <PageShell title="Privacy Policy" subtitle="The short version. The full policy is linked at the bottom.">
            <SectionHeader>What we collect</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                Your email and name; any profile details you add (current company, role, years of
                experience, notification preference, photo); the content you submit (résumés and résumé
                text, job descriptions, referral requests, feedback, practice progress); a payment
                reference and status from Razorpay — never your card, UPI or bank details; and basic
                usage analytics.
            </p>

            <SectionHeader>How we use it</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                To run your account and the service, process payments, and generate résumé suggestions —
                your résumé text and the job description are sent to Google Gemini for that purpose only.
                We also send transactional email (Resend), understand usage to improve the product
                (PostHog), and prevent abuse. We don&rsquo;t sell your data or run advertising trackers.
            </p>

            <SectionHeader>Résumé & PII handling</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                Résumé files are stored in a private bucket and served only through short-lived signed
                links. A résumé attached to a referral request is visible only to the member who accepts
                that request.
            </p>

            <SectionHeader>Sub-processors</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                Supabase (database, auth, file storage), Razorpay (payments), Google Gemini (AI résumé
                processing), Resend (email), PostHog (analytics), and our hosting provider. Each
                processes data only to perform its function.
            </p>

            <SectionHeader>Your rights</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                Access, correct, export or delete your data by emailing{' '}
                <a href={`mailto:${BIZ.email}`} style={{ color: 'var(--pop)' }}>{BIZ.email}</a>. Most
                profile fields are editable in-app, and referral notification emails can be turned off in
                your profile.
            </p>

            <p style={{ marginTop: 18 }}>
                <Link to="/privacy" style={{ color: 'var(--pop)' }}>Read the full Privacy Policy →</Link>
            </p>
        </PageShell>
    )
}

// ── /legal/terms — short summary; full terms live at /terms ──────
export function LegalTermsScaffold() {
    return (
        <PageShell title="Terms of Service" subtitle="The short version. The full terms are linked at the bottom.">
            <SectionHeader>Acceptable use</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                One account per person. Don&rsquo;t resell or share paid access, scrape or bulk-download
                content, or try to bypass usage limits, authentication or payment. Don&rsquo;t upload
                unlawful, infringing or malicious content, and don&rsquo;t probe or disrupt our
                infrastructure.
            </p>

            <SectionHeader>Plans</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                Pro and Max are a one-time payment for a fixed term (monthly or yearly) and do not
                auto-renew. When a term ends, the account returns to Free. Prices are in INR and
                processed by Razorpay.
            </p>

            <SectionHeader>Referrals & jobs disclaimer</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                Referrers act independently — Vloombox does not guarantee that a referral will be given,
                or that it leads to an interview or offer. Job listings are aggregated from public
                sources and may be outdated; always confirm details on the employer&rsquo;s official page.
            </p>

            <SectionHeader>AI output</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                Résumé suggestions, scores and explanations are generated by automated models and may
                contain errors. They are for your review — you are responsible for the final content you
                send to employers.
            </p>

            <SectionHeader>Termination & liability</SectionHeader>
            <p style={{ margin: '0 0 14px' }}>
                We may suspend or terminate accounts that break these terms. The service is provided
                &ldquo;as is&rdquo; without warranties, and our liability is limited to the amount you
                paid us in the 3 months before a claim.
            </p>

            <p style={{ marginTop: 18 }}>
                <Link to="/terms" style={{ color: 'var(--pop)' }}>Read the full Terms & Conditions →</Link>
            </p>
        </PageShell>
    )
}

// ── /subscription/success ────────────────────────────────────────
export function SubscriptionSuccessPage() {
    const { plan, refetch } = useEntitlements()
    // The webhook may lag the redirect — re-poll a couple of times.
    useEffect(() => {
        refetch()
        const t1 = setTimeout(refetch, 3000)
        const t2 = setTimeout(refetch, 8000)
        return () => { clearTimeout(t1); clearTimeout(t2) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    const active = plan === 'pro' || plan === 'max'
    return (
        <PageShell title="You're subscribed 🎉" subtitle="Thanks for upgrading to Vloombox Premium.">
            <p style={{ margin: '0 0 12px' }}>
                {active
                    ? <>Your <strong style={{ color: 'var(--bright)' }}>{plan}</strong> plan is active. All premium features are unlocked.</>
                    : <>Payment received. Your plan is being activated — this can take a few seconds. Refresh if it hasn’t updated shortly.</>}
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                <Link to="/" style={{ color: 'var(--pop)', textDecoration: 'none', fontWeight: 700 }}>Browse jobs →</Link>
                <Link to="/profile" style={{ color: 'var(--muted)', textDecoration: 'none' }}>Manage subscription</Link>
            </div>
        </PageShell>
    )
}

// ── /faq (accordion) ─────────────────────────────────────────────
const FAQ_ITEMS = [
    {
        q: 'What is Vloombox?',
        a: VLOOMBOX_BLURB,
    },
    {
        q: 'How do referrals work?',
        a: 'Post a request with the target company and, optionally, attach your résumé. Members who have set that company as their current employer in their profile can see the request and choose to refer you. Vloombox doesn’t independently verify employment, so treat referrals as peer-to-peer help.',
    },
    {
        q: 'Who can see my résumé?',
        a: 'Only the member who accepts your referral request can see a résumé you attach to that request. Résumés stored for the optimiser are private and served only via short-lived signed links.',
    },
    {
        q: 'Do plans auto-renew?',
        a: 'No. Pro and Max are a one-time payment for a fixed term (monthly or yearly). When the term ends you return to Free unless you buy again.',
    },
    {
        q: 'How do I get a refund?',
        a: 'Sales are final except for duplicate charges or a payment that did not activate the plan. Email support.vloombox@gmail.com with your registered email and Razorpay payment ID.',
    },
    {
        q: 'Is the AI résumé output guaranteed?',
        a: 'No. Suggestions and scores are generated by models and can contain errors. Always review and edit before you send anything to an employer.',
    },
]

export function FaqPage() {
    const [open, setOpen] = useState(null)
    return (
        <PageShell title="FAQ" subtitle="Quick answers about Vloombox.">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {FAQ_ITEMS.map((item, i) => {
                    const isOpen = open === i
                    return (
                        <div
                            key={i}
                            style={{
                                border: '1px solid var(--subtle)',
                                borderRadius: 10,
                                background: 'var(--panel)',
                                overflow: 'hidden',
                            }}
                        >
                            <button
                                type="button"
                                onClick={() => setOpen(isOpen ? null : i)}
                                style={{
                                    width: '100%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: 12,
                                    padding: '14px 16px',
                                    background: 'transparent',
                                    border: 'none',
                                    cursor: 'pointer',
                                    textAlign: 'left',
                                    color: 'var(--bright)',
                                    fontWeight: 700,
                                    fontSize: '0.9rem',
                                }}
                            >
                                <span>{item.q}</span>
                                <ChevronDown
                                    size={18}
                                    style={{
                                        flexShrink: 0,
                                        transition: 'transform 0.2s',
                                        transform: isOpen ? 'rotate(180deg)' : 'none',
                                        color: 'var(--muted)',
                                    }}
                                />
                            </button>
                            {isOpen && (
                                <div style={{ padding: '0 16px 14px', color: 'var(--accent)', fontSize: '0.86rem', lineHeight: 1.7 }}>
                                    {item.a}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </PageShell>
    )
}
