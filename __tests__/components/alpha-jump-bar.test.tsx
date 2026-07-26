// __tests__/components/alpha-jump-bar.test.tsx
//
// Beta E: the floating letter rail. Letters with no series are rendered dimmed and unclickable;
// clicking a live letter reports its bucket; the active letter (from the visible scroll range)
// carries the highlight; an empty index renders nothing at all.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AlphaJumpBar } from '@/components/alpha-jump-bar';

const buckets = [
    { letter: '#', offset: 0, count: 2 },
    { letter: 'A', offset: 2, count: 3 },
    { letter: 'B', offset: 5, count: 1 },
];

describe('AlphaJumpBar', () => {
    it('renders the full rail, dimming letters that have no series', () => {
        render(<AlphaJumpBar buckets={buckets} activeLetter={null} onJump={() => {}} />);
        expect(screen.getByRole('button', { name: 'Jump to A' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Jump to B' })).toBeEnabled();
        // 'C' has no bucket → present but disabled.
        expect(screen.getByRole('button', { name: 'Jump to C' })).toBeDisabled();
    });

    it('reports the bucket on click', () => {
        const onJump = vi.fn();
        render(<AlphaJumpBar buckets={buckets} activeLetter={null} onJump={onJump} />);
        fireEvent.click(screen.getByRole('button', { name: 'Jump to A' }));
        expect(onJump).toHaveBeenCalledWith({ letter: 'A', offset: 2, count: 3 });
    });

    it('highlights the active letter', () => {
        render(<AlphaJumpBar buckets={buckets} activeLetter="B" onJump={() => {}} />);
        expect(screen.getByRole('button', { name: 'Jump to B' })).toHaveAttribute('data-active', 'true');
        expect(screen.getByRole('button', { name: 'Jump to A' })).toHaveAttribute('data-active', 'false');
    });

    it('renders nothing when there are no buckets', () => {
        const { container } = render(<AlphaJumpBar buckets={[]} activeLetter={null} onJump={() => {}} />);
        expect(container).toBeEmptyDOMElement();
    });
});
