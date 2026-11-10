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

// RESTORED_PARTIAL_MARKER - file incomplete intentional will fix
export function BlogPostPage() { return null }
export function QuestionsPage() { return null }
export function GuidelinesPage() { return null }
export function LegalPrivacyScaffold() { return null }
export function LegalTermsScaffold() { return null }
export function SubscriptionSuccessPage() { return null }
export function FaqPage() { return null }
