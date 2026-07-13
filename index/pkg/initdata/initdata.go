// Package initdata creates the Milvus collection + Neo4j indexes at indexer
// startup. Idempotent: re-running is a no-op when the resources exist.
//
// Spec section 3.3: Milvus collection `evidence_v1`, vectors size 1024,
//   cosine distance, HNSW m=32, ef_construct=200.
//   source field is a partition key for fast per-source filtered searches.
// Spec section 3.4: Neo4j indexes on Document.id, Author.orcid, MeshTerm.id.
package initdata

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/neo4j/neo4j-go-driver/v5/neo4j"
)

type MilvusConfig struct {
	URI             string
	Token           string
	Collection      string
	VectorSize      int
	HNSWM           int
	HNSWEfConstruct int
	Logger          *slog.Logger
}

// milvusResp is the envelope returned by all Milvus RESTful API v2 endpoints.
// HTTP status is always 200; use Code to detect errors.
type milvusResp struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func milvusReq(ctx context.Context, client *http.Client, token, method, url string, body any) (milvusResp, error) {
	var reqBody io.Reader
	if body != nil {
		bs, _ := json.Marshal(body)
		reqBody = bytes.NewReader(bs)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reqBody)
	if err != nil {
		return milvusResp{}, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return milvusResp{}, err
	}
	defer resp.Body.Close()
	var r milvusResp
	_ = json.NewDecoder(resp.Body).Decode(&r)
	return r, nil
}

// EnsureMilvusCollection creates the collection if missing. Idempotent.
// Uses Milvus RESTful API v2 (available since Milvus 2.3.3).
// Retries the initial probe for up to 2 minutes so it survives a race with
// Milvus startup (standalone mode takes ~60-90s to become ready).
func EnsureMilvusCollection(ctx context.Context, cfg MilvusConfig) error {
	if cfg.VectorSize == 0 {
		cfg.VectorSize = 1024
	}
	if cfg.HNSWM == 0 {
		cfg.HNSWM = 32
	}
	if cfg.HNSWEfConstruct == 0 {
		cfg.HNSWEfConstruct = 200
	}
	base := strings.TrimRight(cfg.URI, "/")
	client := &http.Client{Timeout: 30 * time.Second}

	// Probe: GET /v2/vectordb/collections/describe?collectionName={name}
	// Retry for up to 2 minutes to survive Milvus cold-start (~60-90s).
	probeURL := base + "/v2/vectordb/collections/describe?collectionName=" + cfg.Collection
	var r milvusResp
	{
		deadline := time.Now().Add(2 * time.Minute)
		wait := 5 * time.Second
		var err error
		for {
			r, err = milvusReq(ctx, client, cfg.Token, http.MethodGet, probeURL, nil)
			if err == nil {
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("milvus probe (gave up after 2m): %w", err)
			}
			cfg.Logger.Info("milvus not ready, retrying", "wait", wait, "err", err)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(wait):
			}
			if wait < 30*time.Second {
				wait *= 2
			}
		}
	}
	if r.Code == 0 {
		cfg.Logger.Info("milvus collection exists", "name", cfg.Collection)
		// Ensure loaded (idempotent; may already be loaded).
		_, _ = milvusReq(ctx, client, cfg.Token, http.MethodPost,
			base+"/v2/vectordb/collections/load",
			map[string]string{"collectionName": cfg.Collection})
		return nil
	}

	// Create collection with schema. source is a partition key so Milvus can
	// prune partitions during source-filtered ANN searches.
	createBody := map[string]any{
		"collectionName": cfg.Collection,
		"schema": map[string]any{
			"autoId":              false,
			"enabledDynamicField": true, // future fields stored without schema migration
			"fields": []map[string]any{
				{
					"fieldName":        "doc_id",
					"dataType":         "VarChar",
					"isPrimary":        true,
					"elementTypeParams": map[string]string{"max_length": "256"},
				},
				{
					"fieldName":        "embedding",
					"dataType":         "FloatVector",
					"elementTypeParams": map[string]string{"dim": fmt.Sprintf("%d", cfg.VectorSize)},
				},
				{
					"fieldName":        "source",
					"dataType":         "VarChar",
					"isPartitionKey":   true,
					"elementTypeParams": map[string]string{"max_length": "64"},
				},
				{
					"fieldName":        "study_type",
					"dataType":         "VarChar",
					"elementTypeParams": map[string]string{"max_length": "64"},
				},
				{"fieldName": "published_year", "dataType": "Int32"},
				{"fieldName": "has_coi_authors", "dataType": "Bool"},
				{
					"fieldName":        "license",
					"dataType":         "VarChar",
					"elementTypeParams": map[string]string{"max_length": "64"},
				},
			},
		},
	}
	r2, err := milvusReq(ctx, client, cfg.Token, http.MethodPost,
		base+"/v2/vectordb/collections/create", createBody)
	if err != nil {
		return fmt.Errorf("milvus create: %w", err)
	}
	if r2.Code != 0 {
		return fmt.Errorf("milvus create error %d: %s", r2.Code, r2.Message)
	}

	// Create indexes: vector (HNSW/COSINE) + scalar indexes for filter fields.
	indexBody := map[string]any{
		"collectionName": cfg.Collection,
		"indexParams": []map[string]any{
			{
				"fieldName":  "embedding",
				"indexName":  "idx_embedding",
				"metricType": "COSINE",
				"params": map[string]any{
					"index_type":     "HNSW",
					"M":              fmt.Sprintf("%d", cfg.HNSWM),
					"efConstruction": fmt.Sprintf("%d", cfg.HNSWEfConstruct),
				},
			},
			{"fieldName": "doc_id", "indexName": "idx_doc_id", "params": map[string]string{"index_type": "INVERTED"}},
			{"fieldName": "study_type", "indexName": "idx_study_type", "params": map[string]string{"index_type": "INVERTED"}},
			{"fieldName": "published_year", "indexName": "idx_year", "params": map[string]string{"index_type": "STL_SORT"}},
			{"fieldName": "has_coi_authors", "indexName": "idx_coi", "params": map[string]string{"index_type": "INVERTED"}},
			{"fieldName": "license", "indexName": "idx_license", "params": map[string]string{"index_type": "INVERTED"}},
		},
	}
	r3, err := milvusReq(ctx, client, cfg.Token, http.MethodPost,
		base+"/v2/vectordb/indexes/create", indexBody)
	if err != nil {
		return fmt.Errorf("milvus index create: %w", err)
	}
	if r3.Code != 0 {
		return fmt.Errorf("milvus index error %d: %s", r3.Code, r3.Message)
	}

	// Load the collection into memory so it can serve searches immediately.
	_, _ = milvusReq(ctx, client, cfg.Token, http.MethodPost,
		base+"/v2/vectordb/collections/load",
		map[string]string{"collectionName": cfg.Collection})

	cfg.Logger.Info("milvus collection created",
		"name", cfg.Collection, "size", cfg.VectorSize,
		"m", cfg.HNSWM, "ef", cfg.HNSWEfConstruct)
	return nil
}

type Neo4jConfig struct {
	URL      string
	User     string
	Password string
	Logger   *slog.Logger
}
