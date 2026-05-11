pub mod capture;
pub mod codec;
pub mod playback;

pub use capture::AudioCapture;
pub use codec::{AudioCodec, OpusCodec};
pub use playback::AudioPlayback;

/// Audio configuration for voice calls
#[derive(Debug, Clone)]
pub struct AudioConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub frame_size: usize,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            sample_rate: 48000,  // 48 kHz
            channels: 1,         // Mono
            frame_size: 960,     // 20ms at 48kHz
        }
    }
}

/// Audio pipeline manager
pub struct AudioPipeline {
    config: AudioConfig,
    codec: OpusCodec,
}

impl AudioPipeline {
    pub fn new() -> Result<Self, String> {
        let config = AudioConfig::default();
        let codec = OpusCodec::new(&config)?;

        Ok(Self { config, codec })
    }

    pub fn with_config(config: AudioConfig) -> Result<Self, String> {
        let codec = OpusCodec::new(&config)?;
        Ok(Self { config, codec })
    }

    pub fn get_config(&self) -> &AudioConfig {
        &self.config
    }

    pub fn get_codec(&self) -> &OpusCodec {
        &self.codec
    }

    /// Encode raw audio frames to compressed Opus
    pub fn encode_frame(&self, pcm_data: &[i16]) -> Result<Vec<u8>, String> {
        self.codec.encode(pcm_data)
    }

    /// Decode Opus frames back to raw audio
    pub fn decode_frame(&self, encoded_data: &[u8]) -> Result<Vec<i16>, String> {
        self.codec.decode(encoded_data)
    }
}

impl Default for AudioPipeline {
    fn default() -> Self {
        Self::new().expect("Failed to create default audio pipeline")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audio_config_defaults() {
        let config = AudioConfig::default();
        assert_eq!(config.sample_rate, 48000);
        assert_eq!(config.channels, 1);
        assert_eq!(config.frame_size, 960);
    }

    #[test]
    fn test_audio_pipeline_creation() {
        let pipeline = AudioPipeline::new();
        assert!(pipeline.is_ok());
    }
}
