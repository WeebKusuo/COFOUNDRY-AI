import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../lib/api/client';
import { Button } from './Button';
import { TextField } from './Field';
import { Switch } from './Switch';
import { Tabs } from './Tabs';
import { QueryState } from './States';

describe('Button', () => {
  it('defaults to type="button" so it never submits forms by accident', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');
  });

  it('is disabled and busy while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Publish
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Publish' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('TextField', () => {
  it('links the label, hint and error for assistive technology', () => {
    render(<TextField label="Weekly hours" hint="1 to 40" error="Enter whole hours." required />);
    const input = screen.getByLabelText(/Weekly hours/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('1 to 40 Enter whole hours.');
    expect(screen.getByText('(required)')).toBeInTheDocument();
  });

  it('is not marked invalid without an error', () => {
    render(<TextField label="Title" />);
    expect(screen.getByLabelText('Title')).not.toHaveAttribute('aria-invalid');
  });
});

describe('Switch', () => {
  it('exposes state as role=switch and in text', async () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onChange={setOn} label="Discoverable" />;
    }
    render(<Harness />);
    const sw = screen.getByRole('switch', { name: 'Discoverable' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveTextContent('Off');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveTextContent('On');
  });
});

describe('Tabs', () => {
  function Harness() {
    const [value, setValue] = useState('a');
    return (
      <Tabs
        label="Inbox"
        value={value}
        onChange={setValue}
        items={[
          { id: 'a', label: 'Invitations', content: <p>Invitation panel</p> },
          { id: 'b', label: 'Requests', content: <p>Request panel</p> },
        ]}
      />
    );
  }

  it('moves selection with arrow keys and keeps one tab in the tab order', async () => {
    render(<Harness />);
    const first = screen.getByRole('tab', { name: 'Invitations' });
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Requests' })).toHaveAttribute('tabindex', '-1');
    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    const second = screen.getByRole('tab', { name: 'Requests' });
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(second).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Request panel');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Invitations' })).toHaveFocus();
  });
});

describe('QueryState', () => {
  const base = { refetch: vi.fn(), isFetching: false };

  it('renders loading', () => {
    render(
      <QueryState
        query={{ ...base, isPending: true, isError: false, data: undefined, error: null }}
      >
        {() => <p>done</p>}
      </QueryState>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });

  it('renders empty', () => {
    render(
      <QueryState
        query={{ ...base, isPending: false, isError: false, data: [] as string[], error: null }}
        isEmpty={(d) => d.length === 0}
        empty={<p>Nothing here</p>}
      >
        {() => <p>done</p>}
      </QueryState>,
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('offers retry for retryable errors and calls refetch', async () => {
    const refetch = vi.fn();
    const error = new ApiError({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Down for a moment.',
    });
    render(
      <QueryState
        query={{
          refetch,
          isFetching: false,
          isPending: false,
          isError: true,
          data: undefined,
          error,
        }}
      >
        {() => <p>done</p>}
      </QueryState>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Down for a moment.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('renders not-found without a retry button', () => {
    const error = new ApiError({ status: 404, code: 'NOT_FOUND', message: 'x' });
    render(
      <QueryState query={{ ...base, isPending: false, isError: true, data: undefined, error }}>
        {() => <p>done</p>}
      </QueryState>,
    );
    expect(screen.getByText('Not found')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders data', () => {
    render(
      <QueryState query={{ ...base, isPending: false, isError: false, data: 'hello', error: null }}>
        {(d) => <p>{d}</p>}
      </QueryState>,
    );
    expect(screen.getByText('hello')).toBeInTheDocument();
  });
});
