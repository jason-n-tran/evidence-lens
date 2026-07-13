package initdata

import "testing"

// Smoke test: defaults take effect when fields are zero.
func TestMilvusConfigDefaults(t *testing.T) {
	cfg := MilvusConfig{Collection: "test"}
	if cfg.VectorSize == 0 {
		cfg.VectorSize = 1024
	}
	if cfg.HNSWM == 0 {
		cfg.HNSWM = 32
	}
	if cfg.HNSWEfConstruct == 0 {
		cfg.HNSWEfConstruct = 200
	}
	if cfg.VectorSize != 1024 || cfg.HNSWM != 32 || cfg.HNSWEfConstruct != 200 {
		t.Errorf("defaults: %+v", cfg)
	}
}
