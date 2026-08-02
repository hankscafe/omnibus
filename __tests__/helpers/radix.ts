// __tests__/helpers/radix.ts
//
// Radix testing house rules (learned in the beta.012 suite): inactive Tabs content UNMOUNTS, and
// TabsTrigger activates on mousedown — a bare click event never switches tabs in jsdom. Open tabs
// with the full sequence.
import { fireEvent, screen } from '@testing-library/react';

export const openTab = (name: RegExp) => {
    const trigger = screen.getByRole('tab', { name });
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
};
