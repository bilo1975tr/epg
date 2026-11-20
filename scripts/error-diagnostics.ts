export type ErrorCategory = 'timeout' | 'http' | 'parse' | 'empty' | 'network' | 'config'
export type ErrorSource = 'grab' | 'validate' | 'sync' | 'api'

export interface AppErrorRecord {
  id: string
  timestamp: string
  source: ErrorSource
  site: string
  channel?: string
  site_id?: string
  lang?: string
  category: ErrorCategory
  message: string
  suggestion: string
  removable?: boolean
}

export function classifyError(rawMessage: string): {
  category: ErrorCategory
  suggestion: string
  removable: boolean
} {
  const lower = rawMessage.toLowerCase()

  if (
    lower.includes('unexpected token') ||
    lower.includes('<!doctype') ||
    lower.includes('<html') ||
    lower.includes('json') ||
    lower.includes('cannot read properties') ||
    lower.includes('xml')
  ) {
    return {
      category: 'parse',
      removable: false,
      suggestion:
        'Site beklenen veri yerine HTML/bozuk yanıt döndürdü (Cloudflare engeli veya site API yapısı değişmiş olabilir). "Siteleri Yükselt" yapın veya siteyi tekrar deneyin.'
    }
  }

  if (lower.includes('status code 400') || lower.includes('400')) {
    return {
      category: 'http',
      removable: false,
      suggestion:
        'Site isteği HTTP 400 (Geçersiz İstek / Güvenlik Doğrulaması) ile reddetti. Sitenin API parametresi veya güvenlik anahtarı değişmiş olabilir; kanalları silmeyin, "Siteleri Yükselt" yapın veya site konfigürasyonunu güncelleyin.'
    }
  }

  if (lower.includes('404') || lower.includes('410')) {
    return {
      category: 'http',
      removable: true,
      suggestion:
        'Kaynak adres sitede artık bulunamıyor (HTTP 404/410). Kanal yayından kalkmış olabilir; listeden çıkarabilirsiniz.'
    }
  }

  if (lower.includes('403') || lower.includes('401') || lower.includes('forbidden')) {
    return {
      category: 'http',
      removable: false,
      suggestion:
        'Site isteği engelledi (HTTP 401/403). Bot koruması, User-Agent kısıtlaması veya bölge (coğrafi) engeli olabilir; geçici olarak silinmez.'
    }
  }

  if (lower.includes('429') || lower.includes('too many requests')) {
    return {
      category: 'http',
      removable: false,
      suggestion:
        'Çok fazla eşzamanlı istek nedeniyle geçici hız sınırı (HTTP 429) uygulandı. Kanallar silinmedi; site başı eşzamanlılık düşürülerek tekrar denenebilir.'
    }
  }

  if (
    lower.includes('status code 5') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504')
  ) {
    return {
      category: 'http',
      removable: false,
      suggestion:
        'Karşı sunucuda geçici sunucu hatası (5xx) oluştu. Daha sonra tekrar deneyin.'
    }
  }

  if (
    lower.includes('timeout') ||
    lower.includes('zaman aşımı') ||
    lower.includes('econnaborted') ||
    lower.includes('etimedout')
  ) {
    return {
      category: 'timeout',
      removable: false,
      suggestion:
        'Site belirlenen sürede yanıt vermedi (Zaman aşımı). Geçici yavaşlık veya erişim sorunu olabilir.'
    }
  }

  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('ehostunreach') ||
    lower.includes('network') ||
    lower.includes('socket')
  ) {
    return {
      category: 'network',
      removable: false,
      suggestion:
        'Site alan adına bağlanılamadı (DNS veya bağlantı hatası). Site adresi değişmiş veya kapanmış olabilir.'
    }
  }

  if (lower.includes('0 program') || lower.includes('0 yayın akışı')) {
    return {
      category: 'empty',
      removable: true,
      suggestion:
        'Kanal bağlandı ancak 0 program döndü (ör. VOD/menü kanalı veya pasif yayın). Otomatik temizlik açıkken listeden çıkarılır.'
    }
  }

  if (lower.includes('config') || lower.includes('parser') || lower.includes('konfigürasyon')) {
    return {
      category: 'config',
      removable: false,
      suggestion:
        'Site konfigürasyon dosyasında uyumluluk hatası var. "Siteleri Yükselt" ile güncel sürümü çekmeyi deneyin.'
    }
  }

  return {
    category: 'http',
    removable: false,
    suggestion:
      'Beklenmeyen site yanıtı. Tekrar deneyin veya sorun devam ederse siteyi kontrol edin.'
  }
}

export function createErrorRecord(params: {
  source: ErrorSource
  site: string
  channel?: string
  site_id?: string
  lang?: string
  message: string
}): AppErrorRecord {
  const { category, suggestion, removable } = classifyError(params.message)
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toLocaleTimeString(),
    source: params.source,
    site: params.site,
    channel: params.channel,
    site_id: params.site_id,
    lang: params.lang,
    category,
    message: params.message,
    suggestion,
    removable
  }
}
