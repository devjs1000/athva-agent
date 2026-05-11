use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Stream, StreamConfig};
use std::sync::{Arc, Mutex};
use std::collections::VecDeque;

pub struct AudioPlayback {
    stream: Option<Stream>,
    buffer: Arc<Mutex<VecDeque<i16>>>,
    is_playing: Arc<Mutex<bool>>,
}

impl AudioPlayback {
    pub fn new(sample_rate: u32, channels: u16) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "No output device available".to_string())?;

        let config = StreamConfig {
            channels,
            sample_rate,
            buffer_size: cpal::BufferSize::Default,
        };

        let buffer = Arc::new(Mutex::new(VecDeque::new()));
        let buffer_clone = buffer.clone();
        let is_playing = Arc::new(Mutex::new(false));
        let is_playing_clone = is_playing.clone();

        let stream = device
            .build_output_stream(
                &config,
                move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                    if *is_playing_clone.lock().unwrap() {
                        let mut buf = buffer_clone.lock().unwrap();
                        for sample in data.iter_mut() {
                            *sample = buf.pop_front().unwrap_or(0);
                        }
                    } else {
                        for sample in data.iter_mut() {
                            *sample = 0;
                        }
                    }
                },
                move |err| {
                    eprintln!("Audio playback error: {}", err);
                },
                None,
            )
            .map_err(|e| e.to_string())?;

        Ok(Self {
            stream: Some(stream),
            buffer,
            is_playing,
        })
    }

    /// Start playback
    pub fn start(&self) -> Result<(), String> {
        if let Some(stream) = &self.stream {
            *self.is_playing.lock().unwrap() = true;
            stream.play().map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Stream not initialized".to_string())
        }
    }

    /// Stop playback
    pub fn stop(&self) -> Result<(), String> {
        *self.is_playing.lock().unwrap() = false;
        if let Some(stream) = &self.stream {
            stream.pause().map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Stream not initialized".to_string())
        }
    }

    /// Queue audio samples for playback
    pub fn queue_samples(&self, samples: &[i16]) -> Result<(), String> {
        let mut buf = self.buffer.lock().unwrap();
        for &sample in samples {
            buf.push_back(sample);
        }
        Ok(())
    }

    /// Get number of samples in buffer
    pub fn sample_count(&self) -> usize {
        self.buffer.lock().unwrap().len()
    }

    /// Check if currently playing
    pub fn is_playing(&self) -> bool {
        *self.is_playing.lock().unwrap()
    }

    /// Clear the playback buffer
    pub fn clear(&self) -> Result<(), String> {
        self.buffer.lock().unwrap().clear();
        Ok(())
    }
}

impl Drop for AudioPlayback {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audio_playback_creation() {
        // This test will only work if audio devices are available
        let result = AudioPlayback::new(48000, 1);
        // We don't assert success here because CI environments may not have audio
        let _ = result;
    }
}
