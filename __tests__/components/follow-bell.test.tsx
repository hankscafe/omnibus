// Shared FollowBell (Beta C): controlled + optimistic. Click reports the new state to the parent
// immediately and POSTs the EXPLICIT follow value (a double-click can't invert intent); a failed
// request rolls the parent back. Click never bubbles — the bell lives inside navigating cards.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FollowBell } from '@/components/follow-bell';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

describe('FollowBell', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }));
    });

    it('renders follow vs following state via aria-pressed', () => {
        const { rerender } = render(<FollowBell seriesId="s1" seriesName="Saga" isFollowing={false} onToggled={() => {}} />);
        expect(screen.getByRole('button', { name: /follow saga/i }).getAttribute('aria-pressed')).toBe('false');

        rerender(<FollowBell seriesId="s1" seriesName="Saga" isFollowing={true} onToggled={() => {}} />);
        expect(screen.getByRole('button', { name: /unfollow saga/i }).getAttribute('aria-pressed')).toBe('true');
    });

    it('optimistically reports the new state and POSTs the explicit follow value', async () => {
        const onToggled = vi.fn();
        render(<FollowBell seriesId="s1" isFollowing={false} onToggled={onToggled} />);

        fireEvent.click(screen.getByRole('button'));

        expect(onToggled).toHaveBeenCalledWith('s1', true);
        await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/library/follow', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ seriesId: 's1', follow: true }),
        })));
    });

    it('rolls the parent back and toasts when the request fails', async () => {
        (fetch as any).mockResolvedValue({ ok: false, status: 500 });
        const onToggled = vi.fn();
        render(<FollowBell seriesId="s1" isFollowing={false} onToggled={onToggled} />);

        fireEvent.click(screen.getByRole('button'));

        await waitFor(() => expect(onToggled).toHaveBeenCalledWith('s1', false));
        expect(onToggled.mock.calls.map(c => c[1])).toEqual([true, false]); // optimistic, then revert
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    });

    it('stops click propagation so card navigation never fires', () => {
        const parentClick = vi.fn();
        render(<div onClick={parentClick}><FollowBell seriesId="s1" isFollowing={false} onToggled={() => {}} /></div>);

        fireEvent.click(screen.getByRole('button'));

        expect(parentClick).not.toHaveBeenCalled();
    });
});
