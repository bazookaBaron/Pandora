import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import MarkdownRenderer from '../components/interview/MarkdownRenderer'
import { LoadingState, ErrorState, EmptyState } from '../components/shared/states'
import { apiFetch } from '../lib/apiClient'
import { useEntitlements } from '../lib/useEntitlements'
import { BIZ, ContentPage } from './LegalPages'
import { Button, Row } from '../components/ui'
import { VLOOMBOX_BLURB, VLOOMBOX_ABOUT, VLOOMBOX_FEATURES } from '../lib/brand'

// Long date for posts ('November 25, 2026').
function fmtLongDate(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

// ── /about ────────────────────────────────────────────────────────
export function AboutPage() {
    return (
        <ContentPage title="About Vloombox" subtitle="What we do and who runs it">
            <p className="content-lead">{VLOOMBOX_BLURB}</p>
            {VLOOMBOX_ABOUT.map((para, i) => (
                <p key={i}>{para}</p>
            ))}

            <h2>What&rsquo;s inside</h2>
            <ul>
                {VLOOMBOX_FEATURES.map(([name, desc]) => (
                    <li key={name}>
                        <strong>{name}</strong> — {desc}
                    </li>
                ))}
            </ul>

            <h2>Who runs it</h2>
            <p>
                Vloombox is a small, independent project, built and actively maintained.
                Bugs, questions and feature requests are welcome at{' '}
                <a href={`mailto:${BIZ.email}`}>{BIZ.email}</a>, or from the
                Feedback section of your profile once you&rsquo;re signed in.
            </p>
        </ContentPage>
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
        <ContentPage title="Blog" subtitle="Interview, design and resume tips" prose={false}>
            {isLoading ? (
                <LoadingState label="Loading posts…" />
            ) : error ? (
                <ErrorState err={error} onRetry={refetch} />
            ) : posts.length === 0 ? (
                <EmptyState art="doc" title="No posts yet" message="Check back soon." />
            ) : (
                <ul className="sys-rows" aria-label="Posts">
                    {posts.map((p) => (
                        <li key={p.slug}>
                            <Row
                                title={p.title}
                                sub={`${fmtLongDate(p.published_at)}${p.reading_time_minutes ? ` · ${p.reading_time_minutes} min` : ''}`}
                                meta={p.category || undefined}
                                to={`/blog/${encodeURIComponent(p.slug)}`}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </ContentPage>
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
        <ContentPage title={post?.title || 'Blog'} prose={false} subtitle={post ? `${fmtLongDate(post.published_at)}${post.reading_time_minutes ? ` · ${post.reading_time_minutes} min read` : ''}` : ''}>
            <p className="content-back"><Link to="/blog">← All posts</Link></p>
            {isLoading ? (
                <LoadingState label="Loading…" />
            ) : error ? (
                error.status === 404
                    ? <EmptyState art="search" title="Post not found" message="This article doesn’t exist or isn’t published." />
                    : <ErrorState err={error} onRetry={refetch} />
            ) : (
                <div className="markdown-body blog-body">
                    <MarkdownRenderer>{post.content || ''}</MarkdownRenderer>
                </div>
            )}
        </ContentPage>
    )
}

// ── /legal/guidelines ────────────────────────────────────────────
export function GuidelinesPage() {
    return (
        <ContentPage title="Community Guidelines" subtitle="How to use the referral board">
            <p>
                The referral board only works if people trust it. These guidelines apply to referral
                requests, the company and role details on your profile, feedback you send, and anything
                else you post. They sit alongside our{' '}
                <Link to="/terms">Terms & Conditions</Link>.
            </p>

            <h2>Be honest</h2>
            <ul>
                <li>Only list a company as your current employer if you actually work there.</li>
                <li>Only request a referral for a role you genuinely want and are reasonably qualified for.</li>
                <li>Don&rsquo;t misrepresent your experience, seniority or the job you&rsquo;re targeting.</li>
            </ul>

            <h2>Keep it respectful</h2>
            <ul>
                <li>No spam, mass-posting, or re-posting the same request over and over.</li>
                <li>No harassment, discrimination or abusive language toward other members.</li>
                <li>A referral is always the other person&rsquo;s choice — don&rsquo;t pressure anyone for one.</li>
            </ul>

            <h2>No paying for referrals</h2>
            <p>
                Referrals on Vloombox are a favour between peers. Do not offer, request or accept money,
                gifts or any other consideration in exchange for a referral. Accounts that do will be removed.
            </p>

            <h2>Respect privacy</h2>
            <ul>
                <li>A résumé shared with you through a referral request is for evaluating that request only — don&rsquo;t forward, publish or reuse it.</li>
                <li>Don&rsquo;t post other people&rsquo;s personal information.</li>
            </ul>

            <h2>Enforcement</h2>
            <p>
                We may hide content, close requests, or suspend or terminate accounts that break these
                guidelines. To report something, email{' '}
                <a href={`mailto:${BIZ.email}`}>{BIZ.email}</a>.
            </p>
        </ContentPage>
    )
}

// ── /legal/privacy — short summary; full policy lives at /privacy ─
export function LegalPrivacyScaffold() {
    return (
        <ContentPage title="Privacy Policy" subtitle="The short version">
            <h2>What we collect</h2>
            <p>
                Your email and name; any profile details you add (current company, role, years of
                experience, notification preference, photo); the content you submit (résumés and résumé
                text, job descriptions, referral requests, feedback, practice progress); a payment
                reference and status from Razorpay — never your card, UPI or bank details; and basic
                usage analytics.
            </p>

            <h2>How we use it</h2>
            <p>
                To run your account and the service, process payments, and generate résumé suggestions —
                your résumé text and the job description are sent to Google Gemini for that purpose only.
                We also send transactional email (Resend), understand usage to improve the product
                (PostHog), and prevent abuse. We don&rsquo;t sell your data or run advertising trackers.
            </p>

            <h2>Résumé & PII handling</h2>
            <p>
                Résumé files are stored in a private bucket and served only through short-lived signed
                links. A résumé attached to a referral request is visible only to the member who accepts
                that request.
            </p>

            <h2>Sub-processors</h2>
            <p>
                Supabase (database, auth, file storage), Razorpay (payments), Google Gemini (AI résumé
                processing), Resend (email), PostHog (analytics), and our hosting provider. Each
                processes data only to perform its function.
            </p>

            <h2>Your rights</h2>
            <p>
                Access, correct, export or delete your data by emailing{' '}
                <a href={`mailto:${BIZ.email}`}>{BIZ.email}</a>. Most
                profile fields are editable in-app, and referral notification emails can be turned off in
                your profile.
            </p>

            <p>
                <Link to="/privacy">Read the full Privacy Policy →</Link>
            </p>
        </ContentPage>
    )
}

// ── /legal/terms — short summary; full terms live at /terms ──────
export function LegalTermsScaffold() {
    return (
        <ContentPage title="Terms of Service" subtitle="The short version">
            <h2>Acceptable use</h2>
            <p>
                One account per person. Don&rsquo;t resell or share paid access, scrape or bulk-download
                content, or try to bypass usage limits, authentication or payment. Don&rsquo;t upload
                unlawful, infringing or malicious content, and don&rsquo;t probe or disrupt our
                infrastructure.
            </p>

            <h2>Plans</h2>
            <p>
                Pro and Max are a one-time payment for a fixed term (monthly or yearly) and do not
                auto-renew. When a term ends, the account returns to Free. Prices are in INR and
                processed by Razorpay.
            </p>

            <h2>Referrals & jobs disclaimer</h2>
            <p>
                Referrers act independently — Vloombox does not guarantee that a referral will be given,
                or that it leads to an interview or offer. Job listings are aggregated from public
                sources and may be outdated; always confirm details on the employer&rsquo;s official page.
            </p>

            <h2>AI output</h2>
            <p>
                Résumé suggestions, scores and explanations are generated by automated models and may
                contain errors. They are for your review — you are responsible for the final content you
                send to employers.
            </p>

            <h2>Termination & liability</h2>
            <p>
                We may suspend or terminate accounts that break these terms. The service is provided
                &ldquo;as is&rdquo; without warranties, and our liability is limited to the amount you
                paid us in the 3 months before a claim.
            </p>

            <p>
                <Link to="/terms">Read the full Terms & Conditions →</Link>
            </p>
        </ContentPage>
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
        <ContentPage title="You're subscribed" subtitle="Thanks for upgrading">
            <p>
                {active
                    ? <>Your <strong>{plan}</strong> plan is active. All premium features are unlocked.</>
                    : <>Payment received. Your plan is being activated — this can take a few seconds. Refresh if it hasn’t updated shortly.</>}
            </p>
            <p className="content-actions">
                <Button variant="primary" to="/">Browse jobs</Button>
                <Button to="/profile">Manage subscription</Button>
            </p>
        </ContentPage>
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
    return (
        <ContentPage title="FAQ" subtitle="Quick answers about Vloombox">
            {FAQ_ITEMS.map((item) => (
                <details key={item.q}>
                    <summary>{item.q}</summary>
                    <p>{item.a}</p>
                </details>
            ))}
        </ContentPage>
    )
}
