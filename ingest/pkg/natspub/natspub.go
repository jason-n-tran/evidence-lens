// Package natspub publishes RawDocEvent messages directly to NATS
// JetStream. Replaces the GCP Pub/Sub + pubsub-bridge worker hop now
// that ingesters run on Dokploy alongside the in-cluster NATS server.
package natspub

import (
	"context"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/proto"
)

// Publisher is a thin wrapper around a NATS connection pinned to one
// subject prefix (e.g. "raw-docs"). Per-source subjects are derived as
// "{prefix}.{source}" so the existing processor consumer ("raw-docs.>")
// keeps working unchanged.
type Publisher struct {
	nc            *nats.Conn
	subjectPrefix string
}

// New connects to NATS and returns a Publisher. natsURL is e.g.
// "nats://truenas.lan:4222". subjectPrefix is the topic name (without
// per-source suffix), e.g. "raw-docs".
func New(_ context.Context, natsURL, subjectPrefix string) (*Publisher, error) {
	nc, err := nats.Connect(natsURL,
		nats.Name("evidencelens-ingester"),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("nats connect: %w", err)
	}
	return &Publisher{nc: nc, subjectPrefix: subjectPrefix}, nil
}

// Close drains in-flight publishes and closes the connection.
func (p *Publisher) Close() {
	_ = p.nc.Drain()
}

// PublishRaw emits a RawDocEvent JSON envelope on subject
// "{subjectPrefix}.{source}". Returns the NATS message id (request id)
// for log correlation; on error the empty string and error.
func (p *Publisher) PublishRaw(_ context.Context, source, docID, objectKey string) (string, error) {
	subject := fmt.Sprintf("%s.%s", p.subjectPrefix, source)
	body := fmt.Sprintf(`{"source":%q,"doc_id":%q,"object_key":%q,"ingested_at":%q}`,
		source, docID, objectKey, time.Now().UTC().Format(time.RFC3339))
	if err := p.nc.Publish(subject, []byte(body)); err != nil {
		return "", fmt.Errorf("nats publish %s: %w", subject, err)
	}
	return docID, nil
}

// PublishProto emits a pre-marshalled protobuf payload on the supplied
// subject (caller picks; usually "{subjectPrefix}.{source}"). Use when
// the caller already holds a generated message struct.
func (p *Publisher) PublishProto(_ context.Context, subject string, msg proto.Message) error {
	data, err := proto.Marshal(msg)
	if err != nil {
		return err
	}
	return p.nc.Publish(subject, data)
}
