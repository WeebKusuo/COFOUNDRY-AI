import { useSearchParams } from 'react-router';
import { Tabs } from '../../components/ui';
import { InterviewListPage } from '../interviews/InterviewListPage';
import { useInterviews } from '../interviews/api';
import { useRequests } from './api';
import { RequestList } from './RequestPages';

/** Section 02 candidate inbox: interview invitations and collaboration requests in separate tabs. */
export function CandidateInboxPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'requests' ? 'requests' : 'interviews';
  const interviews = useInterviews('candidate');
  const requests = useRequests('inbox');
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">Inbox</h1>
        <p className="mt-1 text-ink-muted">
          Interview invitations and collaboration requests from founders. Each expires 7 days after
          it was sent.
        </p>
      </div>
      <Tabs
        label="Inbox"
        value={tab}
        onChange={(id) =>
          setParams(id === 'requests' ? { tab: 'requests' } : {}, { replace: true })
        }
        items={[
          {
            id: 'interviews',
            label: 'Interview invitations',
            count: interviews.data?.filter((i) => i.status === 'invited').length,
            content: <InterviewListPage viewer="candidate" embedded />,
          },
          {
            id: 'requests',
            label: 'Collaboration requests',
            count: requests.data?.filter((r) => r.status === 'pending').length,
            content: <RequestList box="inbox" />,
          },
        ]}
      />
    </div>
  );
}
