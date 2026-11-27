import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Lock, SlidersHorizontal } from 'lucide-react'
import Pagination from '../../components/shared/Pagination'
import { useProgress } from '../../lib/useProgress'
import { useAuth } from '../../contexts/AuthContext'
import { apiFetch } from '../../lib/apiClient'
import { consumeInitialData } from '../../lib/initialData'
import { ErrorState, EmptyState } from '../../components/shared/states'
import Navbar from '../../components/Navbar'
import CompanySelector from '../../components/shared/CompanySelector'
import { PageContainer } from '../../components/shared/Layout'
import { SearchInput, Button, PageHeader, Progress, Sheet, HelpChip, Row, StatusBanner } from '../../components/ui'
import { CheckRow, ChipSelect, DiffDot, difficultyChip } from '../../components/interview/PrepList'
import { track as trackUi, TRACK } from '../../lib/track'
import { TERMS } from '../../lib/copy'

const HLD_PAGE_SIZE = 12

export default function HLDListPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const [search, setSearch] = useState(searchParams.get('q') || '')
    const [filtersOpen, setFiltersOpen] = useState(false)
    const { user } = useAuth()
    const companies = searchParams.get('company') ? searchParams.get('company').split(',') : []
    const difficulties = searchParams.get('difficulty') ? searchParams.get('difficulty').split(',') : []

    // ── Authenticated catalog query ───────────────────────────────────
    // The server returns the FULL list to every tier, but a free user
    // (`access: 'list_only'`) gets each item stripped to id/title/companies/
    // difficulty with `locked: true` and no description/slug — enough to browse,
    // nothing to practice with. Pro/max get full rows + `access: 'full'`.
    // queryKey never varies with search/company/difficulty (those filter the
    // fetched list client-side), so the server-embedded snapshot always
    // matches what this key would fetch anyway.
    const { data, isLoading, isError, error, refetch } = useQuery({
        queryKey: ['catalog-hld'],
        queryFn: () => apiFetch('/api/catalog/hld'),
        staleTime: 5 * 60 * 1000,
        initialData: () => consumeInitialData('hldList'),
    })

    const items = data?.items || []
    const total = data?.total ?? items.length
    const access = data?.access || 'list_only'
    const listOnly = access === 'list_only'

    const { progressMap, toggleStatus } = useProgress('hld')

    const updateParam = (key, value) => {
        setSearchParams(p => {
            const n = new URLSearchParams(p)
            if (!value || (Array.isArray(value) && !value.length)) n.delete(key)
            else n.set(key, Array.isArray(value) ? value.join(',') : value)
            return n
        }, { replace: true })
    }

    const filtered = items.filter(p => {
        if (search && !p.title?.toLowerCase().includes(search.toLowerCase()) && !(p.description || '').toLowerCase().includes(search.toLowerCase())) return false
        if (difficulties.length && !difficulties.includes(p.difficulty)) return false
        if (companies.length && !companies.some(c => (p.companies || []).includes(c))) return false
        return true
    })

    const [page, setPage] = useState(1)
    const pageCount = Math.max(1, Math.ceil(filtered.length / HLD_PAGE_SIZE))
    useEffect(() => { setPage(1) }, [search, searchParams.get('company'), searchParams.get('difficulty')])
    const safePage = Math.min(page, pageCount)
    const pageItems = filtered.slice((safePage - 1) * HLD_PAGE_SIZE, safePage * HLD_PAGE_SIZE)

    const attempted = Object.values(progressMap).filter(r => r.status === 'solved').length
    const diffChip = difficultyChip(difficulties)

    // Locked row (free / list_only): the whole row links to /pricing.
    const renderLocked = (p) => (
        <li key={p.id}>
            <Row
                to="/pricing"
                leading={<Lock size={16} aria-hidden="true" />}
                title={p.title}
                meta={<DiffDot difficulty={p.difficulty} />}
                aria-label={`${p.title} (locked, upgrade to practise)`}
                onClick={() => trackUi(TRACK.CTA_CLICK, { id: 'hld_locked_row', section: 'prepare' })}
            />
        </li>
    )

    // Full row (pro / max)
    const renderRow = (p) => {
        const prog = progressMap[p.id]
        const isAttempted = prog?.status === 'solved'
        return (
            <CheckRow
                key={p.id}
                checked={isAttempted}
                onToggle={() => toggleStatus(p.id, prog?.status ?? 'unsolved')}
                checkLabel={isAttempted ? `Mark ${p.title} as not done` : `Mark ${p.title} as done`}
                title={p.title}
                difficulty={p.difficulty}
                to={`/hld/${p.slug || p.id}`}
            />
        )
    }

    return (
        <>
            <Navbar />
            <PageContainer width="sm" className="pr-list">
                <PageHeader
                    section="prepare"
                    back={{ to: '/prepare', label: 'Prepare' }}
                    title={TERMS.hld.one}
                    subtitle="Design big apps, like a chat app"
                    aside={<HelpChip term="hld" />}
                >
                    {user && !listOnly && total > 0 && (
                        <Progress value={attempted} max={total} tone="success" thin text={`${attempted}/${total} done`} label="System design questions done" />
                    )}
                </PageHeader>

                {listOnly && !isLoading && !isError && (
                    <StatusBanner tone="action" text="Practice needs a Pro plan. Browse free."
                        action={{ label: 'Upgrade', to: '/pricing', onClick: () => trackUi(TRACK.CTA_CLICK, { id: 'hld_upgrade', section: 'prepare' }) }} />
                )}

                <div className="pr-bar">
                    <SearchInput
                        className="pr-bar-main"
                        label="Search system design questions"
                        value={search}
                        onChange={v => { setSearch(v); updateParam('q', v) }}
                        placeholder="Search…"
                    />
                    <ChipSelect label="Difficulty" value={diffChip.value} options={diffChip.options}
                        active={difficulties.length > 0} onChange={v => updateParam('difficulty', v ? [v] : [])} />
                    <button type="button" className={`pr-chip pr-chip-btn${companies.length ? ' is-on' : ''}`}
                        onClick={() => setFiltersOpen(true)} aria-haspopup="dialog"
                        aria-label={companies.length ? `Company filter, ${companies.length} on` : 'Filter by company'}>
                        <SlidersHorizontal size={16} aria-hidden="true" />
                        {companies.length > 0 && <span className="pr-chip-count">{companies.length}</span>}
                    </button>
                </div>

                <Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters"
                    footer={<button type="button" className="sys-tone-btn is-block pr-tone" onClick={() => setFiltersOpen(false)}>Show {filtered.length} questions</button>}>
                    <div className="pr-sheet">
                        <div className="pr-fs">
                            <span className="pr-fs-label">Company</span>
                            <CompanySelector selected={companies} onChange={v => updateParam('company', v)} />
                        </div>
                    </div>
                </Sheet>

                {isLoading ? (
                    <ul className="sys-rows" role="status" aria-label="Loading questions">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <li key={i} className="pr-skel"><i style={{ width: 20, height: 20 }} /><i style={{ flex: 1 }} /></li>
                        ))}
                    </ul>
                ) : isError ? (
                    <ErrorState title="Could not load the questions." err={error} onRetry={() => refetch()} />
                ) : filtered.length === 0 ? (
                    <EmptyState
                        art="diagram"
                        tone="plan"
                        title="No questions match."
                        action={<Button onClick={() => { setSearch(''); setSearchParams({}) }}>Clear filters</Button>}
                    />
                ) : (
                    <>
                        <ul className="sys-rows pr-rows" aria-label="System design questions">
                            {pageItems.map(listOnly ? renderLocked : renderRow)}
                        </ul>
                        <Pagination
                            page={safePage}
                            totalPages={pageCount}
                            accent="var(--green)"
                            label="Question pages"
                            onChange={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                        />
                    </>
                )}
            </PageContainer>
        </>
    )
}
